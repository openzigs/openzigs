import type { Locator, Page } from "@playwright/test";

export class PitchLibraryPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly newDeckLink: Locator;
  readonly emptyHeading: Locator;
  readonly loadErrorMessage: Locator;
  readonly retryButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Pitch Decks" });
    this.newDeckLink = page.getByRole("link", { name: "New Deck" }).first();
    this.emptyHeading = page.getByRole("heading", { name: "No decks yet" });
    this.loadErrorMessage = page.getByText("Could not load decks.");
    this.retryButton = page.getByRole("button", { name: "Retry" });
  }

  async goto() {
    await this.page.goto("/pitch", { waitUntil: "domcontentloaded" });
    await this.heading.waitFor({ state: "visible", timeout: 15_000 });
  }

  deckTitle(title: string): Locator {
    return this.page.getByRole("heading", { name: title });
  }

  errorDetail(detail: RegExp): Locator {
    return this.page.getByText(detail);
  }
}

export default PitchLibraryPage;