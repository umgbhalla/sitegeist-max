import type { SettingsTab } from "@earendil-works/pi-web-ui";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";

type Theme = "light" | "dark" | "system";

/** Applies a theme choice the same way static/theme-loader.js does on load. Unset means dark. */
export function applyTheme(theme: Theme) {
	localStorage.setItem("theme", theme);
	const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
}

const currentTheme = (): Theme => (localStorage.getItem("theme") as Theme | null) ?? "dark";

/**
 * Settings as a top-level view of the side panel instead of a modal. Section
 * tabs stay mounted while hidden, so unsaved input survives switching sections.
 */
@customElement("settings-panel")
export class SettingsPanel extends LitElement {
	@property({ attribute: false }) tabs: SettingsTab[] = [];
	@state() private active = 0;
	@state() private theme: Theme = currentTheme();

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "contents";
	}

	private setTheme(theme: Theme) {
		applyTheme(theme);
		this.theme = theme;
	}

	override render() {
		const themes: Theme[] = ["dark", "light", "system"];
		return html`
			<div class="flex h-full min-h-0 flex-col">
				<div class="settings-sections" role="tablist" aria-label=${i18n("Settings")}>
					${this.tabs.map(
						(tab, index) => html`
							<button
								type="button"
								role="tab"
								class="segment"
								aria-selected=${this.active === index}
								@click=${() => {
									this.active = index;
								}}
							>
								${tab.getTabName()}
							</button>
						`,
					)}
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					${
						this.active === 0
							? html`<div class="settings-row">
									<span class="text-sm font-medium">${i18n("Theme")}</span>
									<div class="segments" role="radiogroup" aria-label=${i18n("Theme")}>
										${themes.map(
											(theme) => html`<button
												type="button"
												role="radio"
												class="segment"
												aria-checked=${this.theme === theme}
												@click=${() => this.setTheme(theme)}
											>
												${i18n(theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System")}
											</button>`,
										)}
									</div>
								</div>`
							: ""
					}
					${this.tabs.map((tab, index) => html`<div ?hidden=${this.active !== index}>${tab}</div>`)}
				</div>
			</div>
		`;
	}
}
