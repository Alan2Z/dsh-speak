# dsh-events-check.py — verify the "可选事件播报" DisclosureRow expands and
# shows its five toggles (was broken: open hardcoded false + no-op onToggle).
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 1400})
    pg.goto("http://127.0.0.1:3080/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(4000)
    pg.get_by_text("设置", exact=True).first.click(timeout=5000)
    pg.wait_for_timeout(1000)
    pg.get_by_text("dsh-speak 设置", exact=True).first.click(timeout=5000)
    pg.wait_for_timeout(1200)

    # click the disclosure row (data-disclosure-row with the 可选事件播报 title)
    row = pg.locator('[data-disclosure-row]', has_text="可选事件播报").first
    print("折叠行存在:", row.count() > 0)
    if row.count() > 0:
        print("点击前 aria-expanded:", row.get_attribute('aria-expanded'))
        row.click(timeout=3000)
        pg.wait_for_timeout(800)
        print("点击后 aria-expanded:", row.get_attribute('aria-expanded'))

    # after: the five event toggles should be visible (substring match — the
    # label element may contain extra description text, exact=True would miss it)
    body = pg.inner_text("body")
    for label in ["回合结束", "命令完成", "目标变更", "工具出错", "待办更新"]:
        print(f"  点击后 '{label}' 在页面中: {label in body}")

    b.close()
print("events check done")
