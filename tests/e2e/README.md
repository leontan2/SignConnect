# Browser tests

Playwright specifications live in this directory. The configuration intentionally does not start SignConnect services; the full-stack runner added in Task 07 will own their lifecycle.

Install Playwright's bundled Chromium once, then run the default automated suite:

```powershell
npx playwright install chromium
npm run test:e2e
```

The default script selects the `chromium` project and does not depend on a branded browser installed on the machine. To validate the supported installed-browser channels, install current desktop Chrome and Edge and run:

```powershell
npm run test:e2e:installed
```

Either channel can also be selected independently with `npx playwright test --project=chrome` or `npx playwright test --project=edge`. Firefox, WebKit/Safari, and mobile projects are intentionally not configured.

Use `@axe-core/playwright` from a specification when an accessibility scan is appropriate:

```ts
import AxeBuilder from "@axe-core/playwright";

const results = await new AxeBuilder({ page }).analyze();
```
