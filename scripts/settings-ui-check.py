# settings-ui-check.py — full settings-page UI verification:
# entry label, bilingual text, master switch, disclosures, instant-apply toggles.
from playwright.sync_api import sync_playwright
import json, urllib.request, time

BASE = "http://127.0.0.1:3080"

def control(action, text=None):
    body = {"action": action}
    if text is not None:
        body["text"] = text
    req = urllib.request.Request(BASE + "/dsh-speak/control", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 1600})
    pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(4000)

    # 1. open settings via sidebar nav
    pg.get_by_text("设置", exact=True).first.click(timeout=5000)
    pg.wait_for_timeout(1200)

    # 2. entry label: dsh-speak 设置
    entry = pg.get_by_text("dsh-speak 设置", exact=True)
    check("设置页入口 'dsh-speak 设置'", entry.count() > 0 and entry.first.is_visible())
    entry.first.click(timeout=5000)
    pg.wait_for_timeout(1500)

    body = pg.inner_text("body")
    # 3. core toggles / labels present
    for label in ["总开关", "自动播报", "入队所有消息", "Markdown 清理", "审批请求", "提问", "可选事件播报"]:
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

    # 6. instant apply: toggle 待办更新 on, confirm via control route state side effect
    # (the toggle writes the config; a follow-up event would announce it — here we
    # just verify the UI pressed state flips and back)
    todo_toggle = pg.get_by_text("待办更新", exact=True)
    if todo_toggle.count() > 0:
        row_el = todo_toggle.first.locator('xpath=ancestor::*[contains(@class,"dsh-speak-option-row")]').first
        btn = row_el.locator('button').first
        before = btn.get_attribute('aria-pressed')
        btn.click(timeout=3000)
        pg.wait_for_timeout(600)
        after = btn.get_attribute('aria-pressed')
        check(f"待办更新开关即时翻转 ({before} -> {after})", before != after)
        # restore
        if before != after:
            btn.click(timeout=3000)
            pg.wait_for_timeout(600)

    # 7. master switch present and enabled
    master = pg.get_by_text("总开关", exact=True).first
    if master.count() > 0:
        mrow = master.locator('xpath=ancestor::*[contains(@class,"dsh-speak-option-row")]').first
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
