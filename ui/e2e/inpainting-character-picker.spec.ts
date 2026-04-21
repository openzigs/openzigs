import { test, expect, type Route } from "@playwright/test";
import { InpaintingPage } from "./pages/inpainting.page";

/**
 * E2E Tests — Inpainting Studio Character LoRA Picker
 * Epic #868 — LoRA-Trained Character Injection in Inpainting Studio
 * Sub-issue #871 — UI: Add character picker to Inpainting Studio
 *
 * Acceptance Criteria (from #871) mapped to tests below. Every AC gets at
 * least one e2e test; ACs 11–14 (design patterns, responsive layout, lint,
 * build) are out of scope for Playwright and are covered by visual review
 * and the CI build pipeline.
 *
 * | #  | AC                                                              | Test                                           |
 * | -- | --------------------------------------------------------------- | ---------------------------------------------- |
 * | 1  | Character picker dropdown added                                 | "renders the character picker in the sidebar" |
 * | 2  | Fetches characters and filters to status=ready + trainedLoraPath| "only lists ready characters with a LoRA path" |
 * | 3  | Each option shows character name                                | "shows character name and trigger word in options" |
 * | 4  | Selecting inserts trigger word into prompt                      | "inserts the trigger word into the prompt on select" |
 * | 5  | Deselecting removes trigger word                                | "removes the trigger word when the selection is cleared" |
 * | 6  | "No character" default                                          | "defaults to the No character option"          |
 * | 7  | character_id sent as FormData on submit                         | "sends character_id as FormData to /inpaint"   |
 * | 8  | Picker disabled when no characters available                    | "disables picker and shows empty state when no ready characters" |
 * | 9  | Loading state shown while fetching                              | "shows a loading state while fetching characters" |
 * | 10 | Error state shown on fetch failure (non-blocking)               | "shows an error state without blocking inpaint submission" |
 * | -- | Kontext model disables picker (epic #868 risk mitigation)       | "disables picker for Flux Kontext model"      |
 * | -- | Switching to Kontext clears selection + trigger word (bug fix)  | "clears selected character and strips trigger word when switching to Kontext" |
 * | -- | Existing no-character flow still works (#868 epic AC)           | "submits without character_id when none selected" |
 */

interface CharacterFixture {
  id: string;
  name: string;
  triggerWord: string;
  trainedLoraPath: string | null;
  status: "pending" | "training" | "ready" | "failed";
}

const ALICE: CharacterFixture = {
  id: "char-alice",
  name: "Alice",
  triggerWord: "alicetok",
  trainedLoraPath: "/loras/alice.safetensors",
  status: "ready",
};

const BOB: CharacterFixture = {
  id: "char-bob",
  name: "Bob",
  triggerWord: "bobtok",
  trainedLoraPath: "/loras/bob.safetensors",
  status: "ready",
};

const TRAINING_CHAR: CharacterFixture = {
  id: "char-training",
  name: "TrainingCarol",
  triggerWord: "caroltok",
  trainedLoraPath: null,
  status: "training",
};

const NO_LORA_READY: CharacterFixture = {
  id: "char-no-lora",
  name: "NoLoraDave",
  triggerWord: "davetok",
  trainedLoraPath: null,
  status: "ready",
};

async function mockCharacters(
  page: import("@playwright/test").Page,
  characters: CharacterFixture[],
) {
  await page.route("**/api/characters**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ characters }),
    }),
  );
}

async function mockCharactersError(page: import("@playwright/test").Page) {
  await page.route("**/api/characters**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom" }),
    }),
  );
}

/** Pending-forever route so the loading state is observable. */
async function mockCharactersPending(page: import("@playwright/test").Page) {
  await page.route("**/api/characters**", async () => {
    // Never resolve — leaves the React Query in loading state.
    await new Promise(() => {});
  });
}

test.describe("Inpainting Studio — Character LoRA Picker (#868 / #871)", () => {
  test.beforeEach(async ({ page }) => {
    // Block any real gallery/queue calls so the page renders deterministically.
    await page.route("**/api/queue/assets**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assets: [] }),
      }),
    );
  });

  // AC1
  test("renders the character picker in the sidebar", async ({ page }) => {
    await mockCharacters(page, [ALICE, BOB]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterSelect).toBeVisible();
  });

  // AC2: dropdown filters out non-ready and missing trainedLoraPath
  test("only lists ready characters with a LoRA path", async ({ page }) => {
    await mockCharacters(page, [ALICE, BOB, TRAINING_CHAR, NO_LORA_READY]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    // Wait for React Query to resolve and the <option>s to render.
    await expect(studio.characterSelect).toBeEnabled();

    const optionTexts = await studio.characterSelect
      .locator("option")
      .allTextContents();

    // "No character" default + both ready-with-LoRA characters → 3 entries.
    expect(optionTexts).toHaveLength(3);
    expect(optionTexts.join("\n")).toContain("No character");
    expect(optionTexts.join("\n")).toContain("Alice");
    expect(optionTexts.join("\n")).toContain("Bob");
    // Filtered out:
    expect(optionTexts.join("\n")).not.toContain("TrainingCarol");
    expect(optionTexts.join("\n")).not.toContain("NoLoraDave");
  });

  // AC3: each option shows the character name (and trigger word for clarity)
  test("shows character name and trigger word in options", async ({ page }) => {
    await mockCharacters(page, [ALICE]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterSelect).toBeEnabled();
    const aliceOption = studio.characterSelect
      .locator("option")
      .filter({ hasText: "Alice" });
    await expect(aliceOption).toHaveText(/Alice/);
    await expect(aliceOption).toHaveText(/alicetok/);
  });

  // AC6: default value is the empty "No character" option
  test("defaults to the No character option", async ({ page }) => {
    await mockCharacters(page, [ALICE]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterSelect).toBeEnabled();
    await expect(studio.characterSelect).toHaveValue("");
  });

  // AC4: selecting a character auto-inserts the trigger word into the prompt
  test("inserts the trigger word into the prompt on select", async ({ page }) => {
    await mockCharacters(page, [ALICE]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await studio.setPrompt("a portrait in a forest");
    await expect(studio.characterSelect).toBeEnabled();
    await studio.selectCharacter(ALICE.id);

    await expect(studio.promptTextarea).toHaveValue(
      /^alicetok\s+a portrait in a forest$/,
    );
  });

  // AC4 edge: trigger word is not duplicated if the user already typed it
  test("does not duplicate the trigger word if already in the prompt", async ({
    page,
  }) => {
    await mockCharacters(page, [ALICE]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await studio.setPrompt("alicetok wearing a red hat");
    await expect(studio.characterSelect).toBeEnabled();
    await studio.selectCharacter(ALICE.id);

    const value = await studio.promptTextarea.inputValue();
    const occurrences = value.match(/alicetok/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  // AC5: deselecting a character removes the trigger word from the prompt
  test("removes the trigger word when the selection is cleared", async ({
    page,
  }) => {
    await mockCharacters(page, [ALICE]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await studio.setPrompt("a portrait in a forest");
    await expect(studio.characterSelect).toBeEnabled();

    await studio.selectCharacter(ALICE.id);
    await expect(studio.promptTextarea).toHaveValue(/alicetok/);

    await studio.selectCharacter(""); // back to "No character"
    await expect(studio.promptTextarea).toHaveValue("a portrait in a forest");
  });

  // AC9: loading state is shown while the characters request is pending
  test("shows a loading state while fetching characters", async ({ page }) => {
    await mockCharactersPending(page);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterLoadingText).toBeVisible();
    // Picker is disabled while loading.
    await expect(studio.characterSelect).toBeDisabled();
  });

  // AC10: error state shown but the rest of the form is still usable
  test("shows an error state without blocking inpaint submission", async ({
    page,
  }) => {
    await mockCharactersError(page);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterErrorText).toBeVisible();
    // User can still type a prompt — picker failure is non-blocking.
    await studio.setPrompt("a red balloon");
    await expect(studio.promptTextarea).toHaveValue("a red balloon");
  });

  // AC8: when no ready+LoRA characters exist, picker is disabled with helpful text
  test("disables picker and shows empty state when no ready characters", async ({
    page,
  }) => {
    await mockCharacters(page, [TRAINING_CHAR, NO_LORA_READY]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    await expect(studio.characterEmptyText).toBeVisible();
    await expect(studio.characterSelect).toBeDisabled();
  });

  // Epic #868 risk mitigation: Flux Kontext does not respond to SDXL-trained
  // LoRAs, so the picker must be disabled when Kontext is the selected model.
  test("disables picker for Flux Kontext model", async ({ page }) => {
    await mockCharacters(page, [ALICE, BOB]);
    const studio = new InpaintingPage(page);
    await studio.goto();

    // Flux Kontext is the default model on page load.
    await expect(studio.characterSelect).toBeDisabled();
    await expect(studio.characterKontextWarning).toBeVisible();

    // Switching to Flux Dev re-enables the picker.
    await studio.selectModel("flux-dev");
    await expect(studio.characterSelect).toBeEnabled();
    await expect(studio.characterKontextWarning).not.toBeVisible();

    // Switching back to Kontext disables it again.
    await studio.selectModel("flux-kontext");
    await expect(studio.characterSelect).toBeDisabled();
  });

  // Bug fix: previously, selecting a character then switching to Kontext left
  // `selectedCharacterId` populated. Submit then attached `character_id` to
  // FormData and the backend rejected with 400. The fix auto-clears the
  // selection (and strips the trigger word) when Kontext becomes active.
  test("clears selected character and strips trigger word when switching to Kontext", async ({
    page,
  }) => {
    await mockCharacters(page, [ALICE]);

    let capturedBody: string | null = null;
    await page.route("**/api/admin/creative/inpaint", async (route: Route) => {
      capturedBody = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobId: "job-test-clear",
          status: "queued",
          message: "ok",
        }),
      });
    });
    await page.route("**/api/queue/jobs/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "job-test-clear",
          status: "complete",
          result: {},
        }),
      }),
    );

    const studio = new InpaintingPage(page);
    await studio.goto();

    // Pick a non-Kontext model so the picker is enabled, then select Alice.
    await studio.selectModel("flux-dev");
    await studio.uploadSampleImage();
    await expect(studio.characterSelect).toBeEnabled();
    await studio.selectCharacter(ALICE.id);
    await expect(studio.promptTextarea).toHaveValue(/alicetok/);
    await expect(studio.characterSelect).toHaveValue(ALICE.id);

    // Switch to Kontext — selection must clear and trigger word must be stripped.
    await studio.selectModel("flux-kontext");
    await expect(studio.characterSelect).toBeDisabled();
    await expect(studio.characterSelect).toHaveValue("");
    await expect(studio.promptTextarea).not.toHaveValue(/alicetok/);

    // Add a real prompt and submit — character_id must NOT be in the payload.
    await studio.setPrompt("a serene mountain at sunrise");
    const inpaintRequest = page.waitForRequest(
      "**/api/admin/creative/inpaint",
    );
    await studio.submit();
    await inpaintRequest;

    expect(capturedBody ?? "").not.toContain('name="character_id"');
    expect(capturedBody ?? "").not.toContain(ALICE.id);
  });

  // AC7: character_id is attached as FormData when the user submits /inpaint
  test("sends character_id as FormData to /inpaint", async ({ page }) => {
    await mockCharacters(page, [ALICE]);

    let capturedBody: string | null = null;
    let capturedContentType: string | null = null;

    await page.route("**/api/admin/creative/inpaint", async (route: Route) => {
      const request = route.request();
      capturedContentType = request.headers()["content-type"] ?? null;
      capturedBody = request.postData();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobId: "job-test-1",
          status: "queued",
          message: "ok",
        }),
      });
    });

    // Short-circuit the poll so the mutation resolves immediately.
    await page.route("**/api/queue/jobs/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "job-test-1",
          status: "complete",
          result: {},
        }),
      }),
    );

    const studio = new InpaintingPage(page);
    await studio.goto();

    // Need a non-Kontext model so the picker is enabled.
    await studio.selectModel("flux-dev");
    await studio.uploadSampleImage();
    await expect(studio.characterSelect).toBeEnabled();
    await studio.selectCharacter(ALICE.id);
    // After selection the prompt already has the trigger word — append context.
    await expect(studio.promptTextarea).toHaveValue(/alicetok/);
    await studio.promptTextarea.fill("alicetok standing on a beach");
    await expect(studio.generateButton).toBeEnabled();

    const inpaintRequest = page.waitForRequest(
      "**/api/admin/creative/inpaint",
    );
    await studio.submit();
    await inpaintRequest;

    expect(capturedContentType ?? "").toContain("multipart/form-data");
    expect(capturedBody ?? "").toContain('name="character_id"');
    expect(capturedBody ?? "").toContain(ALICE.id);
    // Sanity: the prompt is also present as a form field.
    expect(capturedBody ?? "").toContain('name="prompt"');
  });

  // Epic #868 epic-level AC: existing no-character inpainting still works.
  test("submits without character_id when none selected", async ({ page }) => {
    await mockCharacters(page, [ALICE]);

    let capturedBody: string | null = null;
    await page.route("**/api/admin/creative/inpaint", async (route: Route) => {
      capturedBody = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobId: "job-test-2",
          status: "queued",
          message: "ok",
        }),
      });
    });
    await page.route("**/api/queue/jobs/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "job-test-2",
          status: "complete",
          result: {},
        }),
      }),
    );

    const studio = new InpaintingPage(page);
    await studio.goto();

    await studio.selectModel("flux-dev");
    await studio.uploadSampleImage();
    await studio.setPrompt("a serene mountain at sunrise");
    await expect(studio.characterSelect).toHaveValue("");
    await expect(studio.generateButton).toBeEnabled();

    const inpaintRequest = page.waitForRequest(
      "**/api/admin/creative/inpaint",
    );
    await studio.submit();
    await inpaintRequest;

    // character_id must NOT be attached when no character is selected.
    expect(capturedBody ?? "").not.toContain('name="character_id"');
    expect(capturedBody ?? "").toContain('name="prompt"');
  });
});
