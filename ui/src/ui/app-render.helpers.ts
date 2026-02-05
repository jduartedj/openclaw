import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "./app-view-state.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type { GatewaySessionRow, SessionsListResult } from "./types.ts";
import { refreshChat } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import { OpenClawApp } from "./app.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

export function renderChatControls(state: AppViewState) {
  const mainSessionKey = resolveMainSessionKey(state.hello, state.sessionsResult);
  const sessionOptions = resolveSessionOptions(
    state.sessionKey,
    state.sessionsResult,
    mainSessionKey,
  );
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  // Refresh icon
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          ?disabled=${!state.connected}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            state.sessionKey = next;
            state.chatMessage = "";
            state.chatStream = null;
            (state as unknown as OpenClawApp).chatStreamStartedAt = null;
            state.chatRunId = null;
            (state as unknown as OpenClawApp).resetToolStream();
            (state as unknown as OpenClawApp).resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: next,
              lastActiveSessionKey: next,
            });
            void state.loadAssistantIdentity();
            syncUrlWithSessionKey(next, true);
            void loadChatHistory(state as unknown as ChatState);
          }}
        >
          ${repeat(
            sessionOptions,
            (entry) => entry.key,
            (entry) =>
              html`<option value=${entry.key}>
                ${entry.displayName ?? entry.key}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${() => {
          (state as unknown as OpenClawApp).resetToolStream();
          void refreshChat(state as unknown as Parameters<typeof refreshChat>[0]);
        }}
        title="Refresh chat data"
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${
          disableThinkingToggle
            ? "Disabled during onboarding"
            : "Toggle assistant thinking/working output"
        }
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${
          disableFocusToggle
            ? "Disabled during onboarding"
            : "Toggle focus mode (hide sidebar + page header)"
        }
      >
        ${focusIcon}
      </button>
    </div>
  `;
}

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

function resolveMainSessionKey(
  hello: AppViewState["hello"],
  sessions: SessionsListResult | null,
): string | null {
  const snapshot = hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  if (sessions?.sessions?.some((row) => row.key === "main")) {
    return "main";
  }
  return null;
}

function resolveSessionDisplayName(key: string, row?: SessionsListResult["sessions"][number]) {
  const label = row?.label?.trim();
  if (label) {
    return `${label} (${key})`;
  }
  const displayName = row?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return key;
}

function resolveSessionOptions(
  sessionKey: string,
  sessions: SessionsListResult | null,
  mainSessionKey?: string | null,
) {
  const seen = new Set<string>();
  const options: Array<{ key: string; displayName?: string }> = [];

  const resolvedMain = mainSessionKey && sessions?.sessions?.find((s) => s.key === mainSessionKey);
  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add main session key first
  if (mainSessionKey) {
    seen.add(mainSessionKey);
    options.push({
      key: mainSessionKey,
      displayName: resolveSessionDisplayName(mainSessionKey, resolvedMain || undefined),
    });
  }

  // Add current session key next
  if (!seen.has(sessionKey)) {
    seen.add(sessionKey);
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
    });
  }

  // Add sessions from the result
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        options.push({
          key: s.key,
          displayName: resolveSessionDisplayName(s.key, s),
        });
      }
    }
  }

  return options;
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

export function renderThemeToggle(state: AppViewState) {
  const index = Math.max(0, THEME_ORDER.indexOf(state.theme));
  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);
  };

  return html`
    <div class="theme-toggle" style="--theme-index: ${index};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${state.theme === "system" ? "active" : ""}"
          @click=${applyTheme("system")}
          aria-pressed=${state.theme === "system"}
          aria-label="System theme"
          title="System"
        >
          ${renderMonitorIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "light" ? "active" : ""}"
          @click=${applyTheme("light")}
          aria-pressed=${state.theme === "light"}
          aria-label="Light theme"
          title="Light"
        >
          ${renderSunIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "dark" ? "active" : ""}"
          @click=${applyTheme("dark")}
          aria-pressed=${state.theme === "dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${renderMoonIcon()}
        </button>
      </div>
    </div>
  `;
}

function renderSunIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `;
}

function renderMoonIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `;
}

function renderMonitorIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `;
}

export type SidebarSessionsProps = {
  sessions: GatewaySessionRow[];
  pinnedSessions: string[];
  isCollapsed: boolean;
  currentSessionKey: string;
  basePath: string;
  onToggleCollapse: () => void;
  onTogglePin: (key: string) => void;
  onSelectSession: (key: string) => void;
};

type SessionGroup = {
  id: string;
  label: string;
  icon?: string;
  sessions: Array<GatewaySessionRow & { friendlyName: string; isChild: boolean }>;
};

/**
 * Parse session key and displayName to extract group and friendly name.
 * Examples:
 * - "agent:main:main" → { group: "main", name: "Main", isChild: false }
 * - "agent:main:secondary" → { group: "main", name: "Secondary", isChild: true }
 * - "agent:main:whatsapp:group:..." with displayName "whatsapp:g-manos" → { group: "whatsapp", name: "Manos (group)", isChild: false }
 * - "agent:main:cron:..." → { group: "cron", name: "Cron Job", isChild: false }
 * - "agent:main:subagent:..." with label → { group: "subagents", name: label, isChild: true }
 */
function parseSessionInfo(session: GatewaySessionRow): {
  group: string;
  name: string;
  isChild: boolean;
  sortKey: string;
} {
  const key = session.key;
  const displayName = session.displayName || "";
  const label = session.label || "";

  // Parse the key structure: agent:agentId:type:...
  const parts = key.split(":");

  // Main session
  if (key === "agent:main:main" || key === "main") {
    return { group: "main", name: "Main", isChild: false, sortKey: "0" };
  }

  // Secondary agent
  if (key === "agent:main:secondary" || key.endsWith(":secondary")) {
    return { group: "main", name: "Secondary", isChild: true, sortKey: "1" };
  }

  // WhatsApp sessions
  if (key.includes(":whatsapp:")) {
    // Parse displayName like "whatsapp:g-manos" or "whatsapp:manos"
    let name = displayName;
    let isGroupChat = false;

    if (displayName.startsWith("whatsapp:")) {
      name = displayName.replace("whatsapp:", "");
    }

    // Handle group prefix "g-"
    if (name.startsWith("g-")) {
      name = name.slice(2);
      isGroupChat = true;
    }

    // Capitalize and clean up the name (replace hyphens with spaces, title case)
    name = name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    if (isGroupChat) {
      name = `${name} (group)`;
    }

    return { group: "whatsapp", name, isChild: false, sortKey: name.toLowerCase() };
  }

  // Telegram sessions
  if (key.includes(":telegram:")) {
    let name = displayName;
    if (displayName.startsWith("telegram:")) {
      name = displayName.replace("telegram:", "");
    }
    if (name.startsWith("g-")) {
      name = name.slice(2) + " (group)";
    }
    name = name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    return { group: "telegram", name, isChild: false, sortKey: name.toLowerCase() };
  }

  // Discord sessions
  if (key.includes(":discord:")) {
    let name = displayName;
    if (displayName.startsWith("discord:")) {
      name = displayName.replace("discord:", "");
    }
    name = name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    return { group: "discord", name, isChild: false, sortKey: name.toLowerCase() };
  }

  // Cron sessions
  if (key.includes(":cron:")) {
    // Use label if available, otherwise show truncated ID
    const cronId = parts[parts.length - 1];
    const name = label || `Job ${cronId.slice(0, 8)}`;
    return { group: "cron", name, isChild: false, sortKey: cronId };
  }

  // Subagent sessions
  if (key.includes(":subagent:")) {
    // Use label if available, otherwise show truncated ID
    const subagentId = parts[parts.length - 1];
    const name = label || `Task ${subagentId.slice(0, 8)}`;
    return { group: "subagents", name, isChild: true, sortKey: subagentId };
  }

  // Webchat sessions
  if (session.channel === "webchat" && !key.includes(":whatsapp:")) {
    const name = displayName || label || key.split(":").pop() || "Webchat";
    return { group: "webchat", name, isChild: false, sortKey: name.toLowerCase() };
  }

  // Fallback - unknown type
  const name = displayName || label || key.split(":").pop() || key;
  return { group: "other", name, isChild: false, sortKey: name.toLowerCase() };
}

const GROUP_ORDER: Record<string, number> = {
  main: 0,
  webchat: 1,
  whatsapp: 2,
  telegram: 3,
  discord: 4,
  subagents: 5,
  cron: 6,
  other: 7,
};

const GROUP_LABELS: Record<string, string> = {
  main: "Main",
  webchat: "Webchat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  subagents: "Subagents",
  cron: "Cron Jobs",
  other: "Other",
};

export function renderSidebarSessions(props: SidebarSessionsProps) {
  const {
    sessions,
    pinnedSessions,
    isCollapsed,
    currentSessionKey,
    basePath,
    onToggleCollapse,
    onTogglePin,
    onSelectSession,
  } = props;

  const pinnedSet = new Set(pinnedSessions);
  const chatPath = pathForTab("chat", basePath);

  // Sort all sessions by updatedAt descending
  const sortedSessions = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // Take top 50 unpinned + all pinned
  const pinned = sortedSessions.filter((s) => pinnedSet.has(s.key));
  const unpinned = sortedSessions.filter((s) => !pinnedSet.has(s.key)).slice(0, 50);
  const allSessions = [...pinned, ...unpinned];

  // Group sessions
  const groupsMap = new Map<string, SessionGroup>();

  for (const session of allSessions) {
    const info = parseSessionInfo(session);
    const groupId = info.group;

    if (!groupsMap.has(groupId)) {
      groupsMap.set(groupId, {
        id: groupId,
        label: GROUP_LABELS[groupId] || groupId,
        sessions: [],
      });
    }

    groupsMap.get(groupId)!.sessions.push({
      ...session,
      friendlyName: info.name,
      isChild: info.isChild,
    });
  }

  // Sort groups by predefined order
  const groups = Array.from(groupsMap.values()).sort(
    (a, b) => (GROUP_ORDER[a.id] ?? 99) - (GROUP_ORDER[b.id] ?? 99),
  );

  // When collapsed, only show pinned sessions (flat, no grouping)
  if (isCollapsed) {
    const pinnedOnly = pinned.map((s) => ({
      ...s,
      friendlyName: parseSessionInfo(s).name,
      isChild: parseSessionInfo(s).isChild,
    }));

    return html`
      <div class="nav-group nav-group--sessions nav-group--collapsed">
        <button
          class="nav-label"
          @click=${onToggleCollapse}
          aria-expanded=${false}
          title="Expand sessions"
        >
          <span class="nav-label__text">Sessions</span>
          <span class="nav-label__chevron">+</span>
        </button>
        <div class="nav-group__items nav-sessions-list">
          ${
            pinnedOnly.length === 0
              ? html`
                  <div class="nav-sessions-empty muted">No pinned</div>
                `
              : pinnedOnly.map((session) =>
                  renderSessionItem(
                    session,
                    pinnedSet,
                    currentSessionKey,
                    chatPath,
                    onTogglePin,
                    onSelectSession,
                  ),
                )
          }
        </div>
      </div>
    `;
  }

  return html`
    <div class="nav-group nav-group--sessions">
      <button
        class="nav-label"
        @click=${onToggleCollapse}
        aria-expanded=${true}
        title="Collapse sessions"
      >
        <span class="nav-label__text">Sessions</span>
        <span class="nav-label__chevron">−</span>
      </button>
      <div class="nav-group__items nav-sessions-list">
        ${
          groups.length === 0
            ? html`
                <div class="nav-sessions-empty muted">No sessions</div>
              `
            : groups.map(
                (group) => html`
                <div class="nav-session-group">
                  <div class="nav-session-group-label">${group.label}</div>
                  ${group.sessions.map((session) =>
                    renderSessionItem(
                      session,
                      pinnedSet,
                      currentSessionKey,
                      chatPath,
                      onTogglePin,
                      onSelectSession,
                    ),
                  )}
                </div>
              `,
              )
        }
      </div>
    </div>
  `;
}

function renderSessionItem(
  session: GatewaySessionRow & { friendlyName: string; isChild: boolean },
  pinnedSet: Set<string>,
  currentSessionKey: string,
  chatPath: string,
  onTogglePin: (key: string) => void,
  onSelectSession: (key: string) => void,
) {
  const isPinned = pinnedSet.has(session.key);
  const isActive = session.key === currentSessionKey;
  const displayName = session.friendlyName;
  const truncatedName = displayName.length > 22 ? displayName.slice(0, 20) + "…" : displayName;
  const href = `${chatPath}?session=${encodeURIComponent(session.key)}`;

  return html`
    <div class="nav-session-item ${isActive ? "active" : ""} ${isPinned ? "pinned" : ""} ${session.isChild ? "child" : ""}">
      <a
        href=${href}
        class="nav-session-link"
        title="${session.key}"
        @click=${(e: MouseEvent) => {
          if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          ) {
            return;
          }
          e.preventDefault();
          onSelectSession(session.key);
        }}
      >
        <span class="nav-session-name">${truncatedName}</span>
      </a>
      <button
        class="nav-session-pin ${isPinned ? "pinned" : ""}"
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          onTogglePin(session.key);
        }}
        title="${isPinned ? "Unpin session" : "Pin session"}"
        aria-label="${isPinned ? "Unpin session" : "Pin session"}"
      >
        ${isPinned ? icons.pin : icons.pinOff}
      </button>
    </div>
  `;
}

export function renderDashboardLink(dashboardUrl: string) {
  return html`
    <a
      class="nav-item nav-item--external"
      href=${dashboardUrl}
      target="_blank"
      rel="noreferrer"
      title="Work Dashboard (opens in new tab)"
    >
      <span class="nav-item__icon" aria-hidden="true">${icons.layoutDashboard}</span>
      <span class="nav-item__text">Dashboard</span>
      <span class="nav-item__external-icon" aria-hidden="true">${icons.externalLink}</span>
    </a>
  `;
}
