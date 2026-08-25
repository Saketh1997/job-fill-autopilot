from playwright.sync_api import sync_playwright

def main():
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp("http://localhost:9226")
        context = browser.contexts[0]
        for page in context.pages:
            if "tmobile.wd1" in page.url:
                print(f"URL: {page.url}")
                for btn in page.query_selector_all("button, a"):
                    txt = btn.inner_text().strip()
                    if txt: print(f" - {txt}")
                break

if __name__ == "__main__": main()
