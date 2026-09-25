// Microsoft Teams integration: startup context, theme, config page, meeting stage.
import { app, pages, meeting, FrameContexts } from "@microsoft/teams-js";
import { h } from "./dom.ts";

export interface TeamsContext {
  frameContext: FrameContexts | null;
}

export async function initTeams(): Promise<TeamsContext> {
  await app.initialize();
  const ctx = await app.getContext();
  applyTheme(ctx.app.theme);
  app.registerOnThemeChangeHandler(applyTheme);
  return { frameContext: ctx.page.frameContext ?? null };
}

export const isConfigPage = (t: TeamsContext): boolean => t.frameContext === FrameContexts.settings;
export const isSidePanel = (t: TeamsContext): boolean => t.frameContext === FrameContexts.sidePanel;

export function notifyLoaded(): void {
  app.notifySuccess().catch((err: unknown) => console.warn("Could not notify Teams that the app loaded", err));
}

const contentUrl = (): string => `${location.origin}${location.pathname}?inTeams=1`;

/** Shown when the app is added to a meeting. */
export function renderConfig(root: HTMLElement): void {
  root.replaceChildren(h("div", { class: "panel" },
    h("h1", {}, "Even or Odd"),
    h("p", {}, "Adds a two-player Even or Odd game to this meeting. Click Save to continue.")));
  pages.config.registerOnSaveHandler(saveEvent => {
    pages.config.setConfig({
      entityId: "even-odd", suggestedDisplayName: "Even or Odd", contentUrl: contentUrl(), websiteUrl: contentUrl(),
    }).then(() => saveEvent.notifySuccess(), (err: unknown) => saveEvent.notifyFailure(String(err)));
  });
  pages.config.setValidityState(true);
}

export function shareToStage(): void {
  meeting.shareAppContentToStage(err => { if (err) console.error("Share to stage failed", err); }, contentUrl());
}

function applyTheme(theme: string): void {
  document.body.dataset.theme = theme === "contrast" ? "contrast" : "dark";
}
