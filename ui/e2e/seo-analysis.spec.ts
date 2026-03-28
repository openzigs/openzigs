import { test, expect } from './helpers';
import { WorkbenchPage } from './pages/workbench.page';

test.describe('Workbench SEO Gap Analysis (#647)', () => {
  let wb: WorkbenchPage;

  test.beforeEach(async ({ page }) => {
    wb = new WorkbenchPage(page);
    await wb.goto();
  });

  // ── AC: SEO analysis launcher accessible from workbench UI (button) ──

  test('should show SEO button in workbench toolbar', async () => {
    await expect(wb.seoButton).toBeVisible();
    await expect(wb.seoButton).toHaveAttribute(
      'title',
      /SEO Gap Analysis/,
    );
  });

  // ── AC: Launch dialog contains target URL, keyword, search provider ──

  test('should open SEO dialog with all form fields', async () => {
    await wb.openSeoDialog();

    await expect(wb.seoDialogTitle).toBeVisible();
    await expect(wb.seoDialogDescription).toBeVisible();
    await expect(wb.targetUrlInput).toBeVisible();
    await expect(wb.targetKeywordInput).toBeVisible();
    await expect(wb.searchProviderSelect).toBeVisible();
    await expect(wb.analyzeButton).toBeVisible();
    await expect(wb.cancelButton).toBeVisible();
  });

  test('should show correct placeholders on inputs', async () => {
    await wb.openSeoDialog();

    await expect(wb.targetUrlInput).toHaveAttribute(
      'placeholder',
      /https:\/\/example\.com/,
    );
    await expect(wb.targetKeywordInput).toHaveAttribute(
      'placeholder',
      /best project management tools/,
    );
  });

  // ── AC: Form validates URL format and non-empty keyword ──

  test('should disable Analyze button when form is empty', async () => {
    await wb.openSeoDialog();

    // Both fields empty → button disabled
    await expect(wb.analyzeButton).toBeDisabled();
  });

  test('should disable Analyze button when only URL is provided', async () => {
    await wb.openSeoDialog();

    await wb.fillTargetUrl('https://example.com');
    // Keyword still empty → disabled
    await expect(wb.analyzeButton).toBeDisabled();
  });

  test('should disable Analyze button when only keyword is provided', async () => {
    await wb.openSeoDialog();

    await wb.fillTargetKeyword('project management');
    // URL still empty → disabled
    await expect(wb.analyzeButton).toBeDisabled();
  });

  test('should enable Analyze button when both URL and keyword are filled', async () => {
    await wb.openSeoDialog();

    await wb.fillTargetUrl('https://example.com/blog');
    await wb.fillTargetKeyword('seo tips');

    await expect(wb.analyzeButton).toBeEnabled();
  });

  test('should show validation error for malformed URL', async () => {
    await wb.openSeoDialog();

    await wb.fillTargetUrl('not-a-url');
    await wb.fillTargetKeyword('some keyword');
    await wb.submitAnalysis();

    // Error message about valid URL should appear
    await expect(
      wb.page.getByText(/valid URL/i),
    ).toBeVisible();
  });

  // ── AC: Search provider selector has expected options ──

  test('should show search provider options', async () => {
    await wb.openSeoDialog();

    const options = wb.searchProviderSelect.locator('option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText(/Auto/);
    await expect(options.nth(1)).toHaveText(/Serper/);
    await expect(options.nth(2)).toHaveText(/Brave/);
  });

  // ── AC: LLM model picker present in dialog ──

  test('should show LLM model picker label', async () => {
    await wb.openSeoDialog();

    await expect(wb.page.getByText('LLM Model')).toBeVisible();
    await expect(
      wb.page.getByText(/claude-sonnet.*recommended/i),
    ).toBeVisible();
  });

  // ── AC: Dialog cancel button closes dialog ──

  test('should close dialog on cancel', async () => {
    await wb.openSeoDialog();
    await expect(wb.seoDialogTitle).toBeVisible();

    await wb.closeSeoDialog();
    await expect(wb.seoDialogTitle).toBeHidden();
  });

  // ── AC: Form fields reset when dialog reopens ──

  test('should reset form fields when dialog is reopened', async () => {
    await wb.openSeoDialog();

    // Fill some data
    await wb.fillTargetUrl('https://example.com');
    await wb.fillTargetKeyword('test keyword');

    // Close and reopen
    await wb.closeSeoDialog();
    await wb.openSeoDialog();

    // Fields should be empty (the component resets state on close + reopen)
    await expect(wb.targetUrlInput).toHaveValue('');
    await expect(wb.targetKeywordInput).toHaveValue('');
  });

  // ── AC: SEO reports directory visible in workbench sidebar ──

  test('should display sidebar with file tree', async () => {
    await expect(wb.sidebar).toBeVisible();
  });
});

test.describe('Workbench SEO Dialog — error handling (#647)', () => {
  let wb: WorkbenchPage;

  test.beforeEach(async ({ page }) => {
    wb = new WorkbenchPage(page);
    await wb.goto();
    await wb.openSeoDialog();
  });

  // ── AC: Error states handled gracefully ──

  test('should not submit when clicking Analyze with invalid URL', async () => {
    await wb.fillTargetUrl('ftp://invalid');
    await wb.fillTargetKeyword('keyword');
    await wb.submitAnalysis();

    // Dialog should still be open (not closed on error)
    await expect(wb.seoDialogTitle).toBeVisible();
    // Error message about valid URL
    await expect(
      wb.page.getByText(/valid URL/i),
    ).toBeVisible();
  });

  test('should clear error when dialog is closed and reopened', async () => {
    // Trigger an error
    await wb.fillTargetUrl('not-valid');
    await wb.fillTargetKeyword('keyword');
    await wb.submitAnalysis();
    await expect(wb.page.getByText(/valid URL/i)).toBeVisible();

    // Close and reopen
    await wb.closeSeoDialog();
    await wb.openSeoDialog();

    // Error should be gone
    await expect(
      wb.page.getByText(/valid URL/i),
    ).toBeHidden();
  });

  test('should enforce maxLength on URL input', async () => {
    await expect(wb.targetUrlInput).toHaveAttribute('maxlength', '500');
  });

  test('should enforce maxLength on keyword input', async () => {
    await expect(wb.targetKeywordInput).toHaveAttribute('maxlength', '200');
  });
});
