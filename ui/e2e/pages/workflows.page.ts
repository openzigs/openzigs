import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for /workflows — Visual Workflow Builder.
 * Covers the ReactFlow canvas, node palette, toolbar, and config panel.
 */
export class WorkflowsPage {
  readonly page: Page;

  // ── Node Palette (left sidebar) ─────────────────────────────────
  readonly nodePalette: Locator;
  readonly promptStageCard: Locator;
  readonly parallelGroupCard: Locator;
  readonly postActionCard: Locator;
  readonly conditionCard: Locator;
  readonly nodeTypesHeading: Locator;

  // ── Toolbar ─────────────────────────────────────────────────────
  readonly workflowNameInput: Locator;
  readonly saveButton: Locator;
  readonly runButton: Locator;
  readonly stopButton: Locator;
  readonly importButton: Locator;
  readonly exportButton: Locator;
  readonly deleteButton: Locator;
  readonly savedIndicator: Locator;

  // ── Canvas ──────────────────────────────────────────────────────
  readonly canvas: Locator;
  readonly emptyStateText: Locator;
  readonly minimap: Locator;
  readonly controls: Locator;

  // ── Config Panel (right sidebar) ────────────────────────────────
  readonly configPanel: Locator;
  readonly configPanelEmpty: Locator;
  readonly propertiesHeading: Locator;
  readonly nameField: Locator;
  readonly promptField: Locator;
  readonly modelField: Locator;
  readonly timeoutField: Locator;
  readonly actionTypeSelect: Locator;
  readonly panelDeleteButton: Locator;

  constructor(page: Page) {
    this.page = page;

    // Node palette
    this.nodePalette = page.locator('aside').first();
    this.nodeTypesHeading = page.getByText('Node Types');
    this.promptStageCard = page.getByText('Prompt Stage').first();
    this.parallelGroupCard = page.getByText('Parallel Group').first();
    this.postActionCard = page.getByText('Post-Action').first();
    this.conditionCard = page.getByText('Condition', { exact: false }).first();

    // Toolbar buttons
    this.workflowNameInput = page.locator('input[type="text"][value="Untitled Workflow"]');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.runButton = page.getByRole('button', { name: /^Run$/ });
    this.stopButton = page.getByRole('button', { name: 'Stop' });
    this.importButton = page.getByRole('button', { name: 'Import' });
    this.exportButton = page.getByRole('button', { name: 'Export' });
    this.deleteButton = page.getByRole('button', { name: 'Delete' });
    this.savedIndicator = page.getByText('Saved');

    // Canvas area
    this.canvas = page.locator('.react-flow');
    this.emptyStateText = page.getByText('Drag nodes here to start building');
    this.minimap = page.locator('.react-flow__minimap');
    this.controls = page.locator('.react-flow__controls');

    // Config panel
    this.configPanel = page.locator('aside').last();
    this.configPanelEmpty = page.getByText('Select a node to configure');
    this.propertiesHeading = page.getByText('Properties');
    this.nameField = page.getByLabel('Name');
    this.promptField = page.getByPlaceholder('Enter the prompt for this stage...');
    this.modelField = page.getByPlaceholder('e.g. gpt-4o');
    this.timeoutField = page.getByLabel('Timeout (seconds)');
    this.actionTypeSelect = page.getByLabel('Action Type');
    this.panelDeleteButton = page.getByRole('button', { name: 'Delete node' });
  }

  async goto() {
    await this.page.goto('/workflows');
    await this.page.waitForLoadState('domcontentloaded');
    await this.canvas.waitFor({ state: 'visible', timeout: 15_000 });
  }

  /** Get the workflow name input (may have changed value after user typed) */
  getWorkflowNameInput() {
    // The first text input inside the toolbar panel
    return this.page.locator('.react-flow__panel input[type="text"]').first();
  }

  /** Get all ReactFlow nodes currently on the canvas */
  getCanvasNodes() {
    return this.page.locator('.react-flow__node');
  }

  /** Get all ReactFlow edges currently on the canvas */
  getCanvasEdges() {
    return this.page.locator('.react-flow__edge');
  }

  /** Get a specific node by its text content */
  getNodeByText(text: string) {
    return this.page.locator('.react-flow__node').filter({ hasText: text });
  }

  /** Get zoom-in control button */
  getZoomInButton() {
    return this.controls.locator('button').first();
  }

  /** Get zoom-out control button */
  getZoomOutButton() {
    return this.controls.locator('button').nth(1);
  }

  /** Get fit-view control button */
  getFitViewButton() {
    return this.controls.locator('button').nth(2);
  }
}
