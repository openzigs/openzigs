import { test, expect, navigateTo } from './helpers';
import { WorkflowsPage } from './pages/workflows.page';

test.describe('Visual Workflow Builder (#687)', () => {
  let wf: WorkflowsPage;

  test.beforeEach(async ({ page }) => {
    wf = new WorkflowsPage(page);
    await wf.goto();
  });

  // ═══════════════════════════════════════════════════════════════
  // #710 — Base canvas: /workflows route with @xyflow/react
  // ═══════════════════════════════════════════════════════════════

  test.describe('Base Canvas (#710)', () => {
    // AC: Given /workflows is visited, When page loads, Then full-screen ReactFlow canvas renders with background grid
    test('should render ReactFlow canvas with background grid', async () => {
      await expect(wf.canvas).toBeVisible();
      // ReactFlow renders a background element with dots/grid
      await expect(wf.page.locator('.react-flow__background')).toBeVisible();
    });

    // AC: Given the canvas, When the minimap is visible, Then it shows overview
    test('should display minimap', async () => {
      await expect(wf.minimap).toBeVisible();
    });

    // AC: Given the canvas, When zoom controls are visible, Then zoom in/out/fit buttons work
    test('should display zoom controls', async () => {
      await expect(wf.controls).toBeVisible();
      // Controls contain zoom in, zoom out, fit view buttons
      const buttons = wf.controls.locator('button');
      await expect(buttons).toHaveCount(4); // zoom-in, zoom-out, fit-view, lock
    });

    // AC: Basic empty state with "Drag nodes here to start building" placeholder
    test('should show empty state when no nodes exist', async () => {
      await expect(wf.emptyStateText).toBeVisible();
      await expect(wf.page.getByText('Use the palette on the left to add workflow stages')).toBeVisible();
    });

    // AC: /workflows is accessible from the sidebar navigation
    test('should be accessible from the navigation bar', async ({ page }) => {
      await navigateTo(page, '/');
      const nav = page.locator('nav');
      const workflowsLink = nav.getByRole('link', { name: 'Workflows' });
      await expect(workflowsLink).toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #707 — Custom node components
  // ═══════════════════════════════════════════════════════════════

  test.describe('Node Palette & Node Types (#707)', () => {
    // AC: Node palette visible with all node type cards
    test('should display node palette with all node types', async () => {
      await expect(wf.nodeTypesHeading).toBeVisible();
      await expect(wf.promptStageCard).toBeVisible();
      await expect(wf.parallelGroupCard).toBeVisible();
      await expect(wf.postActionCard).toBeVisible();
      await expect(wf.conditionCard).toBeVisible();
    });

    // AC: Prompt Stage has description
    test('should show node type descriptions in palette', async () => {
      await expect(wf.page.getByText('An LLM prompt step with optional tools')).toBeVisible();
      await expect(wf.page.getByText('Fan-out into parallel branches')).toBeVisible();
      await expect(wf.page.getByText('Deterministic post-processing step')).toBeVisible();
    });

    // AC: Given a ConditionNode, When rendered, Then it shows "Coming Soon" badge
    test('should mark Condition node as coming soon', async () => {
      await expect(wf.page.getByText('Conditional branch (coming soon)')).toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #708 — Node property panel (config sidebar)
  // ═══════════════════════════════════════════════════════════════

  test.describe('Node Config Panel (#708)', () => {
    // AC: Given no node is selected, When the panel is visible, Then it shows placeholder
    test('should show empty state when no node selected', async () => {
      await expect(wf.configPanelEmpty).toBeVisible();
    });

    // AC: Panel is responsive and doesn't overlap the canvas
    test('should render config panel alongside canvas', async () => {
      await expect(wf.configPanel).toBeVisible();
      await expect(wf.canvas).toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #710 + #707 — Toolbar & interactions
  // ═══════════════════════════════════════════════════════════════

  test.describe('Toolbar (#710)', () => {
    // AC: Toolbar has save, run, import, export buttons
    test('should display all toolbar buttons', async () => {
      await expect(wf.saveButton).toBeVisible();
      await expect(wf.importButton).toBeVisible();
      await expect(wf.exportButton).toBeVisible();
    });

    // AC: Workflow name input is editable
    test('should have editable workflow name input', async () => {
      const nameInput = wf.getWorkflowNameInput();
      await expect(nameInput).toBeVisible();
      await expect(nameInput).toHaveValue('Untitled Workflow');
    });

    // AC: Run button disabled when no nodes on canvas
    test('should disable Run button when canvas is empty', async () => {
      // The Run button should have disabled:opacity-50 class when nodes.length === 0
      const runButton = wf.page.getByRole('button', { name: /Run/ });
      await expect(runButton).toBeDisabled();
    });

    // AC: Export button disabled when no nodes on canvas
    test('should disable Export button when canvas is empty', async () => {
      await expect(wf.exportButton).toBeDisabled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #707 — Node rendering on canvas (via client-side drop)
  // Note: Playwright doesn't natively do HTML5 drag-drop well with
  // ReactFlow, so we verify node types via programmatic insertion
  // (evaluateScript) similar to real ReactFlow test patterns.
  // ═══════════════════════════════════════════════════════════════

  test.describe('Node Rendering on Canvas (#707)', () => {
    // AC: Given a PromptStageNode, When rendered, Then it shows the stage name
    test('should render PromptStageNode with default name', async ({ page }) => {
      // Simulate a drop by dispatching the drag events programmatically
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await expect(node).toBeVisible();
    });

    // AC: Given a PromptStageNode, When rendered, Then "No prompt set" shown for empty prompt
    test('should show "No prompt set" for new prompt stage', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      await expect(wf.page.getByText('No prompt set')).toBeVisible();
    });

    // AC: Given a ParallelGroupNode, When rendered, Then it shows dashed border and branch count
    test('should render ParallelGroupNode with branch count', async ({ page }) => {
      await simulateNodeDrop(page, 'parallelGroup');
      const node = wf.getNodeByText('Parallel Group');
      await expect(node).toBeVisible();
      await expect(wf.page.getByText(/0 branches/)).toBeVisible();
    });

    // AC: Given a PostActionNode, When rendered, Then it shows the name
    test('should render PostActionNode', async ({ page }) => {
      await simulateNodeDrop(page, 'postAction');
      const node = wf.getNodeByText('Post-Action');
      await expect(node).toBeVisible();
    });

    // AC: Given a ConditionNode, When rendered, Then it has "Coming Soon" badge
    test('should render ConditionNode with Coming Soon badge', async ({ page }) => {
      await simulateNodeDrop(page, 'condition');
      const node = wf.getNodeByText('Condition');
      await expect(node).toBeVisible();
      await expect(node.getByText('Coming Soon')).toBeVisible();
    });

    // AC: Given any node, When selected, Then it highlights
    test('should highlight node when clicked', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await node.click();
      // Config panel should now show Properties instead of empty state
      await expect(wf.propertiesHeading).toBeVisible();
    });

    // AC: Empty state disappears after adding a node
    test('should hide empty state after adding a node', async ({ page }) => {
      await expect(wf.emptyStateText).toBeVisible();
      await simulateNodeDrop(page, 'promptStage');
      await expect(wf.emptyStateText).not.toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #708 — Node property panel editing
  // ═══════════════════════════════════════════════════════════════

  test.describe('Node Config Editing (#708)', () => {
    // AC: Given a PromptStageNode is selected, When the panel opens, Then it shows name, prompt, model, timeout fields
    test('should show prompt stage config fields when node selected', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await node.click();

      await expect(wf.propertiesHeading).toBeVisible();
      await expect(wf.nameField).toBeVisible();
      await expect(wf.promptField).toBeVisible();
      await expect(wf.modelField).toBeVisible();
      await expect(wf.timeoutField).toBeVisible();
    });

    // AC: Given a node config is edited, When changes are made, Then node updates in real-time
    test('should update node name in real-time when edited in panel', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await node.click();

      await wf.nameField.fill('My Custom Stage');
      await expect(wf.getNodeByText('My Custom Stage')).toBeVisible();
    });

    // AC: Given a PostActionNode is selected, When the panel opens, Then it shows action type
    test('should show action type select for PostActionNode', async ({ page }) => {
      await simulateNodeDrop(page, 'postAction');
      const node = wf.getNodeByText('Post-Action');
      await node.click();

      await expect(wf.propertiesHeading).toBeVisible();
      await expect(wf.actionTypeSelect).toBeVisible();
    });

    // AC: Node type and ID metadata visible in panel
    test('should show node type metadata in panel', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await node.click();

      await expect(wf.page.getByText('Type:')).toBeVisible();
      await expect(wf.page.getByText('promptStage')).toBeVisible();
      await expect(wf.page.getByText('ID:')).toBeVisible();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #714 — Import/Export
  // ═══════════════════════════════════════════════════════════════

  test.describe('Import/Export (#714)', () => {
    // AC: Given a visual workflow, When "Export" is clicked, Then a .openzigs-template.json downloads
    test('should trigger export download when Export clicked', async ({ page }) => {
      // Add a node first so export is enabled
      await simulateNodeDrop(page, 'promptStage');
      await expect(wf.exportButton).toBeEnabled();

      // Listen for the download
      const downloadPromise = page.waitForEvent('download');
      await wf.exportButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain('.openzigs-template.json');
    });

    // AC: Import button is always available
    test('should have enabled Import button', async () => {
      await expect(wf.importButton).toBeEnabled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // #712 — Execution: Run Workflow
  // ═══════════════════════════════════════════════════════════════

  test.describe('Workflow Execution UI (#712)', () => {
    // AC: Given a valid workflow, When "Run" is clicked, Then it attempts execution
    test('should enable Run button when nodes exist', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const runButton = page.getByRole('button', { name: /Run/ });
      await expect(runButton).toBeEnabled();
    });

    // AC: Given an invalid graph (no nodes), When "Run" is clicked, Then nothing happens
    test('should not allow run when canvas is empty', async ({ page }) => {
      const runButton = page.getByRole('button', { name: /Run/ });
      await expect(runButton).toBeDisabled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Node deletion
  // ═══════════════════════════════════════════════════════════════

  test.describe('Node Deletion', () => {
    // AC: Delete button appears when node selected and removes the node
    test('should delete a selected node via toolbar', async ({ page }) => {
      await simulateNodeDrop(page, 'promptStage');
      const node = wf.getNodeByText('New Stage');
      await node.click();

      await expect(wf.deleteButton).toBeVisible();
      await wf.deleteButton.click();

      // Node should be gone
      await expect(wf.getCanvasNodes()).toHaveCount(0);
      // Empty state returns
      await expect(wf.emptyStateText).toBeVisible();
    });
  });
});

// ── Helper: simulate node drop on ReactFlow canvas ─────────────────

/**
 * Since Playwright + HTML5 drag-and-drop with ReactFlow is notoriously
 * unreliable, we use page.evaluate to programmatically dispatch the
 * drop event with the correct dataTransfer payload. This mirrors what
 * the browser does when a user drops a dragged palette item.
 */
async function simulateNodeDrop(page: import('@playwright/test').Page, nodeType: string) {
  await page.evaluate((type) => {
    const canvas = document.querySelector('.react-flow__pane');
    if (!canvas) throw new Error('ReactFlow pane not found');

    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Create a DataTransfer mock
    const dt = new DataTransfer();
    dt.setData('application/reactflow', type);

    // Dispatch dragover to set drop effect
    canvas.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer: dt,
      }),
    );

    // Dispatch the drop event
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer: dt,
      }),
    );
  }, nodeType);

  // Wait for the new node to be painted on the canvas
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 5_000 });
}
