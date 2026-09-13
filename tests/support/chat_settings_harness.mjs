import {extractFunction} from './real_harness.mjs';

// Execute the actual settings mutators with inert persistence/listeners. The
// reader exposes the owner's published object, just as Store.getSettings does.
// No inference or browser behavior is simulated by this helper.
export function chatSettingsHarness(source) {
  const functions = ['chatSelectionKey', 'assertChatSelection', 'setSettings', 'setSettingsNow'];
  if (source.includes('function applySettingsPatch(')) functions.push('applySettingsPatch');
  return `
    const CHAT_SELECTION_REVISION = Symbol('chat selection revision');
    const state = {settings: {...initialSettings, [CHAT_SELECTION_REVISION]: Symbol()}};
    const persistSettings = Object.assign(() => {}, {cancel() {}});
    const writeKey = () => true, emit = () => {};
    const STORAGE_KEYS = {settings: 'fixture-settings'};
    ${functions.map(name => extractFunction(source, name)).join('\n')}
    const Store = {getSettings: () => state.settings, setSettings, setSettingsNow, setConnection() {}};
    globalThis.settingsStore = Store;
  `;
}
