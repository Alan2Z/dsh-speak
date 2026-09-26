# settings-ui-check.py — full settings-page UI verification:
# entry label, bilingual text, master switch, disclosures, instant-apply toggles,
# and that an edit actually PERSISTS into the profile patch (see the note in §6).
# Manual helper (NOT part of `npm test`): needs Playwright plus a running DSH web app.
# A fresh browser has no session cookie, so pass the URL `dsh web` printed (the one
# carrying `?token=…`) and the script exchanges it for the cookie first:
#   $env:DSH_WEB_URL = "http://127.0.0.1:3080/?token=<printed-token>"; python scripts/settings-ui-check.py
# An already-authenticated plain URL still works. Point DSH_PROFILE_PATCH at the
# profile patch the Host edits when it is not the default web profile.
from pathlib import Path
from playwright.sync_api import sync_playwright
from urllib.parse import parse_qs, urlsplit, urlunsplit
import os, re, time

_raw_url = os.environ.get("DSH_WEB_URL", "http://127.0.0.1:3080").strip()
_parts = urlsplit(_raw_url)
LAUNCH_TOKEN = (parse_qs(_parts.query).get("token") or [None])[0]
BASE = urlunsplit((_parts.scheme, _parts.netloc, _parts.path.rstrip("/"), "", "")).rstrip("/")
PATCH = Path(os.environ.get("DSH_PROFILE_PATCH", Path.home() / ".dsh" / "profiles" / "web" / "cordis.patch.yml"))

def patch_block():
    """The TOP-LEVEL settings row's text in the profile patch.

    Walking lines rather than matching the first `- id: dsh-speak`: the nested insert
    row comes first in the file and carries no config. The row is the top-level one
    under either the documented id or the pre-1.8.2 one.
    """
    try:
        lines = PATCH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    collected, inside = [], False
    for line in lines:
        if line.startswith("- "):
            if inside:
                break
            inside = bool(re.match(r"^- id: (?:dsh-speak|speech-hook)\b", line))
        if inside:
            collected.append(line)
    return "\n".join(collected)

def patch_effective(field, default):
    """Value of `field` in the patch, treating an absent key as the schema default.

    DSH persists a SPARSE override set (the Loader hands the editor a `simplify()`d
    config), so writing a field back to its schema default removes the key instead of
    storing it — an assertion that only looked for `field: <default>` would hang.
    """
    for line in patch_block().splitlines():
        entry = line.strip()
        if entry.startswith(field + ":"):
            return entry.split(":", 1)[1].strip()
    return default

def wait_for_patch(field, value, default, timeout=20):
    """Poll the profile patch until the write lands; returns (ok, seconds)."""
    start = time.time()
    while time.time() - start < timeout:
        if patch_effective(field, default) == value:
            return True, round(time.time() - start, 1)
        time.sleep(0.25)
    return False, round(time.time() - start, 1)

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 1600})
    # The launch token mints the session cookie and 303s to the clean app URL.
    start = BASE + "/?token=" + LAUNCH_TOKEN if LAUNCH_TOKEN else BASE + "/"
    pg.goto(start, wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(6000)
    if "authentication required" in pg.inner_text("body"):
        print("FAIL  the launch token was rejected or already rotated — restart dsh web and copy the new URL")
        b.close()
        raise SystemExit(1)

    # 1. open settings via sidebar nav
    pg.get_by_text("设置", exact=True).first.click(timeout=30000)
    pg.wait_for_timeout(1200)

    # 2. entry label: dsh-speak 设置
    entry = pg.get_by_text("dsh-speak 设置", exact=True)
    check("设置页入口 'dsh-speak 设置'", entry.count() > 0 and entry.first.is_visible())
    entry.first.click(timeout=5000)
    pg.wait_for_timeout(1500)

    body = pg.inner_text("body")
    # 3. core toggles / labels present
    for label in ["总开关", "自动朗读", "入队所有消息", "Markdown 清理", "播报审批", "播报提问", "可选事件播报"]:
        check(f"设置项可见: {label}", label in body)

    # 4. optional-events disclosure expands to five toggles
    row = pg.locator('[data-disclosure-row]', has_text="可选事件播报").first
    check("可选事件播报折叠行存在", row.count() > 0)
    if row.count() > 0:
        check("折叠行默认收起", row.get_attribute('aria-expanded') == 'false')
        row.click(timeout=3000)
        pg.wait_for_timeout(700)
        check("点击后展开", row.get_attribute('aria-expanded') == 'true')
        body2 = pg.inner_text("body")
        for ev in ["回合结束", "命令完成", "目标变更", "工具出错", "待办更新"]:
            check(f"可选事件开关: {ev}", ev in body2)

    # 5. markdown-cleaning disclosure: default-open, collapses on click
    md = pg.locator('[data-disclosure-row]', has_text="Markdown 清理").first
    if md.count() > 0:
        check("Markdown 清理默认展开", md.get_attribute('aria-expanded') == 'true')
        body3 = pg.inner_text("body")
        check("Markdown 清理含朗读行内代码", "朗读行内代码" in body3)
        check("Markdown 清理含代码块", "代码块" in body3)
        md.click(timeout=3000)
        pg.wait_for_timeout(700)
        check("Markdown 清理点击后收起", md.get_attribute('aria-expanded') == 'false')

    # 6. instant apply AND persistence. Both halves matter:
    #   * the card renders a Toggle as `<inline-field><label/><option-row><button/></option-row>`,
    #     so the button row is the label's FOLLOWING SIBLING (an ancestor lookup silently
    #     matched nothing, which is how this section skipped unnoticed before);
    #   * a `config:` nested inside the profile patch's `insert:` row (the shape 1.8.x
    #     profiles carry) is accepted here — the UI flips and the running plugin obeys —
    #     while DSH's config editor rolls the write back on disk, so the option silently
    #     reverts at the next boot. Only reading the profile patch catches that.
    # The persisted field is 合并延迟/throttleMs: its schema default (1500) differs from
    # both values used here, so the check cannot pass on an absent key.
    row = pg.get_by_text("待办更新:", exact=True)
    check("可选事件开关行 '待办更新:' 存在", row.count() > 0)
    if row.count() > 0:
        row_el = row.first.locator('xpath=following-sibling::div[contains(@class,"dsh-speak-option-row")]').first
        btn = row_el.locator('button').first
        before = btn.get_attribute('aria-pressed')
        btn.click(timeout=3000)
        pg.wait_for_timeout(1500)
        after = btn.get_attribute('aria-pressed')
        check(f"待办更新开关即时翻转 ({before} -> {after})", before != after)
        btn.click(timeout=3000)              # restore
        pg.wait_for_timeout(1500)

    delay_label = pg.locator("div.dsh-speak-field-label", has_text="合并延迟").first
    if delay_label.count() > 0 and PATCH.exists():
        delay_input = delay_label.locator('xpath=ancestor::div[contains(@class,"dsh-speak-field")][1]//input').first
        original = delay_input.input_value()
        target = "777" if original != "777" else "888"
        delay_input.fill(target)
        ok, delay = wait_for_patch("throttleMs", target, "1500", timeout=20)
        check(f"写入落到 profile patch（throttleMs: {target}，{delay}s）", ok)
        delay_input.fill(original)
        ok2, delay2 = wait_for_patch("throttleMs", original, "1500", timeout=20)
        check(f"改回 {original} 也落盘（{delay2}s）", ok2)
    elif not PATCH.exists():
        print(f"SKIP  persistence check — no profile patch at {PATCH} (set DSH_PROFILE_PATCH)")

    # 7. master switch present and enabled
    master = pg.get_by_text("总开关:", exact=True).first
    check("总开关行存在", master.count() > 0)
    if master.count() > 0:
        mrow = master.locator('xpath=following-sibling::div[contains(@class,"dsh-speak-option-row")]').first
        mbtn = mrow.locator('button').first
        check("总开关状态为开", mbtn.get_attribute('aria-pressed') == 'true')

    pg.screenshot(path="scripts/settings-ui-check.png", full_page=True)
    b.close()

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} PASS ====")
if fails:
    print("FAILED:", [r[0] for r in fails])
else:
    print("ALL UI CHECKS PASS ✓")
