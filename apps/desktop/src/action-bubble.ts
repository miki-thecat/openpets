import { app, BrowserWindow, ipcMain, Menu, type MenuItem, screen } from "electron";
import { join } from "node:path";

import { debug, error as logError } from "./logger.js";

const selectChannel = "openpets:action-bubble-select";
const backChannel = "openpets:action-bubble-back";
const closeChannel = "openpets:action-bubble-close";
const modelChannel = "openpets:action-bubble-model";
const defaultPetWindowTitle = "OpenPets — Default Pet";

let installed = false;
let activeSession: ActionBubbleSession | null = null;

interface ActionBubblePage {
  readonly title: string;
  readonly menu: Menu;
}

interface ActionBubbleSession {
  readonly owner: BrowserWindow;
  readonly window: BrowserWindow;
  readonly pages: ActionBubblePage[];
  readonly itemById: Map<string, MenuItem>;
  nextItemId: number;
}

interface ActionBubbleItemModel {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly kind: "group" | "action";
}

interface ActionBubbleModel {
  readonly title: string;
  readonly groups: readonly ActionBubbleItemModel[];
  readonly actions: readonly ActionBubbleItemModel[];
  readonly canGoBack: boolean;
}

type PopupMethod = (this: Menu, options?: unknown) => void;

export function installActionBubbleMenuPatch(): void {
  if (installed) return;
  installed = true;

  const menuPrototype = Menu.prototype as unknown as { popup: PopupMethod };
  const originalPopup = menuPrototype.popup;

  menuPrototype.popup = function patchedPopup(this: Menu, options?: unknown): void {
    const owner = getPopupOwner(options);
    if (!owner || owner.isDestroyed() || owner.getTitle() !== defaultPetWindowTitle) {
      originalPopup.call(this, options);
      return;
    }

    const menu = this;
    void openActionBubble(menu, owner).catch((error) => {
      logError("ui", "action bubble failed; falling back to native menu", error);
      if (!owner.isDestroyed()) originalPopup.call(menu, options);
    });
  };

  ipcMain.handle(selectChannel, async (event, rawId: unknown) => {
    const session = activeSessionForSender(event.sender.id);
    if (!session || typeof rawId !== "string") return { ok: false };
    const item = session.itemById.get(rawId);
    if (!item || item.visible === false || item.enabled === false) return { ok: false };

    if (item.submenu) {
      session.pages.push({ title: item.label || "Menu", menu: item.submenu });
      sendModel(session);
      return { ok: true, navigated: true };
    }

    invokeMenuItem(item, session.owner);
    closeSession(session);
    return { ok: true, navigated: false };
  });

  ipcMain.handle(backChannel, (event) => {
    const session = activeSessionForSender(event.sender.id);
    if (!session) return { ok: false };
    if (session.pages.length > 1) session.pages.pop();
    sendModel(session);
    return { ok: true };
  });

  ipcMain.on(closeChannel, (event) => {
    const session = activeSessionForSender(event.sender.id);
    if (session) closeSession(session);
  });
}

function getPopupOwner(options: unknown): BrowserWindow | null {
  if (!options || typeof options !== "object") return null;
  const owner = (options as { window?: unknown }).window;
  return owner instanceof BrowserWindow ? owner : null;
}

async function openActionBubble(menu: Menu, owner: BrowserWindow): Promise<void> {
  if (activeSession) closeSession(activeSession);

  const width = 336;
  const height = 420;
  const position = getBubblePosition(owner, width, height);
  const bubbleWindow = new BrowserWindow({
    title: "OpenPets Action Bubble",
    width,
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(app.getAppPath(), "action-bubble-preload.cjs"),
    },
  });

  const session: ActionBubbleSession = {
    owner,
    window: bubbleWindow,
    pages: [{ title: "何をしますか？", menu }],
    itemById: new Map(),
    nextItemId: 0,
  };
  activeSession = session;

  bubbleWindow.setMenu(null);
  bubbleWindow.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "pop-up-menu");
  if (process.platform === "darwin") bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bubbleWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  const closeIfOwnerGone = (): void => {
    if (!bubbleWindow.isDestroyed()) bubbleWindow.close();
  };
  owner.once("closed", closeIfOwnerGone);
  bubbleWindow.once("closed", () => {
    owner.removeListener("closed", closeIfOwnerGone);
    if (activeSession === session) activeSession = null;
  });
  bubbleWindow.on("blur", () => {
    setTimeout(() => {
      if (!bubbleWindow.isDestroyed() && !bubbleWindow.isFocused()) bubbleWindow.close();
    }, 90);
  });

  await bubbleWindow.loadURL(buildActionBubbleUrl(buildModel(session)));
  if (bubbleWindow.isDestroyed()) return;
  bubbleWindow.show();
  debug("ui", "action bubble opened", { ownerWindowId: owner.id, itemCount: menu.items.length });
}

function getBubblePosition(owner: BrowserWindow, width: number, height: number): { x: number; y: number } {
  const ownerBounds = owner.getBounds();
  const display = screen.getDisplayMatching(ownerBounds);
  const work = display.workArea;
  const anchorX = ownerBounds.x + ownerBounds.width / 2;
  const anchorY = ownerBounds.y + ownerBounds.height - 54;
  let x = Math.round(anchorX - width / 2);
  let y = Math.round(anchorY - height + 8);
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - width - 8));
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - height - 8));
  return { x, y };
}

function activeSessionForSender(senderId: number): ActionBubbleSession | null {
  const session = activeSession;
  if (!session || session.window.isDestroyed() || session.window.webContents.id !== senderId) return null;
  return session;
}

function buildModel(session: ActionBubbleSession): ActionBubbleModel {
  session.itemById.clear();
  const page = session.pages[session.pages.length - 1]!;
  const groups: ActionBubbleItemModel[] = [];
  const actions: ActionBubbleItemModel[] = [];

  for (const item of page.menu.items) {
    if (item.visible === false || item.type === "separator") continue;
    const id = `item-${++session.nextItemId}`;
    session.itemById.set(id, item);
    const model: ActionBubbleItemModel = {
      id,
      label: item.label || item.sublabel || "Action",
      enabled: item.enabled !== false,
      checked: item.checked === true,
      kind: item.submenu ? "group" : "action",
    };
    if (item.submenu) groups.push(model);
    else actions.push(model);
  }

  return {
    title: page.title,
    groups,
    actions,
    canGoBack: session.pages.length > 1,
  };
}

function sendModel(session: ActionBubbleSession): void {
  if (session.window.isDestroyed()) return;
  session.window.webContents.send(modelChannel, buildModel(session));
}

function invokeMenuItem(item: MenuItem, owner: BrowserWindow): void {
  if (item.type === "checkbox") item.checked = !item.checked;
  const click = item.click as unknown as ((...args: unknown[]) => void) | undefined;
  if (!click) return;
  try {
    click(item, owner);
  } catch (error) {
    logError("ui", "action bubble item failed", error);
  }
}

function closeSession(session: ActionBubbleSession): void {
  if (!session.window.isDestroyed()) session.window.close();
  if (activeSession === session) activeSession = null;
}

function buildActionBubbleUrl(initialModel: ActionBubbleModel): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const model = JSON.stringify(initialModel).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenPets Action Bubble</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#172033;font-family:Inter,"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic","Meiryo",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{padding:10px 10px 24px}
.shell{position:relative;width:100%;height:100%;display:flex;flex-direction:column;padding:16px 16px 14px;border:1px solid rgba(255,255,255,.9);border-radius:24px;background:linear-gradient(145deg,rgba(248,251,255,.985),rgba(239,238,255,.975));box-shadow:0 18px 42px rgba(15,23,42,.20),0 4px 12px rgba(37,99,235,.10),inset 0 1px 0 rgba(255,255,255,.92);overflow:hidden;animation:pop .16s cubic-bezier(.2,0,0,1)}
.shell:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 15% 8%,rgba(255,255,255,.9),transparent 32%),radial-gradient(circle at 92% 15%,rgba(196,181,253,.18),transparent 30%);pointer-events:none}
.tail{position:absolute;left:50%;bottom:12px;width:22px;height:22px;transform:translateX(-50%) rotate(45deg);background:linear-gradient(135deg,rgba(241,241,255,.98),rgba(239,238,255,.98));border-right:1px solid rgba(255,255,255,.9);border-bottom:1px solid rgba(255,255,255,.9);border-bottom-right-radius:5px;box-shadow:5px 5px 11px rgba(15,23,42,.08);z-index:0}
.header{position:relative;z-index:1;display:flex;align-items:center;gap:9px;min-height:34px;margin-bottom:10px}
.back{width:30px;height:30px;flex:0 0 30px;border:0;border-radius:10px;background:rgba(37,99,235,.08);color:#334155;font-size:16px;font-weight:900;cursor:pointer}
.back:hover{background:rgba(37,99,235,.15)}
.back[hidden]{display:none}
.title{min-width:0;font-size:16px;line-height:1.25;font-weight:850;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spark{margin-left:auto;width:25px;height:25px;display:grid;place-items:center;border-radius:999px;background:linear-gradient(135deg,#dbeafe,#ede9fe);font-size:12px}
.content{position:relative;z-index:1;min-height:0;overflow:auto;padding:1px 2px 4px;scrollbar-width:thin}
.section-label{margin:5px 3px 7px;color:#64748b;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.card,.action{border:1px solid rgba(148,163,184,.20);background:rgba(255,255,255,.72);color:#172033;cursor:pointer;transition:transform .12s ease,background .12s ease,border-color .12s ease,box-shadow .12s ease}
.card{min-height:72px;padding:10px;border-radius:16px;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;text-align:left;box-shadow:0 3px 10px rgba(15,23,42,.05)}
.card:hover,.action:hover{transform:translateY(-1px);background:rgba(255,255,255,.96);border-color:rgba(96,165,250,.32);box-shadow:0 8px 18px rgba(37,99,235,.09)}
.icon{display:grid;place-items:center;width:27px;height:27px;border-radius:10px;background:linear-gradient(135deg,#dbeafe,#ede9fe);font-size:14px;margin-bottom:6px}
.card-text{max-width:100%;font-size:11px;line-height:1.2;font-weight:820;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.actions{display:flex;flex-direction:column;gap:6px}
.action{width:100%;min-height:38px;border-radius:12px;padding:8px 10px;display:grid;grid-template-columns:24px minmax(0,1fr) 16px;align-items:center;gap:7px;text-align:left}
.action .mini{font-size:13px;text-align:center}.action .label{font-size:11px;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.action .arrow{color:#94a3b8;text-align:right}
button:disabled{cursor:default;opacity:.43;transform:none!important;box-shadow:none!important}
.empty{display:grid;place-items:center;height:180px;color:#64748b;text-align:center;font-size:12px;line-height:1.6}
.footer{position:relative;z-index:1;margin-top:8px;text-align:center;color:#94a3b8;font-size:9px;font-weight:700;letter-spacing:.04em}
@keyframes pop{from{opacity:0;transform:translateY(5px) scale(.965)}to{opacity:1;transform:translateY(0) scale(1)}}
@media(prefers-reduced-motion:reduce){.shell,.card,.action{animation:none;transition:none}}
</style>
</head>
<body>
<div class="shell">
  <div class="header"><button class="back" id="back" hidden aria-label="戻る">‹</button><div class="title" id="title"></div><div class="spark" aria-hidden="true">✦</div></div>
  <div class="content" id="content"></div>
  <div class="footer">OpenPets</div>
</div>
<div class="tail" aria-hidden="true"></div>
<script>
const api=window.openPetsActionBubble;
let current=${model};
const title=document.getElementById('title'),content=document.getElementById('content'),back=document.getElementById('back');
function iconFor(label){const s=String(label||'').toLowerCase();if(s.includes('memo')||s.includes('note')||s.includes('メモ'))return'📝';if(s.includes('remind')||s.includes('リマイン'))return'⏰';if(s.includes('focus')||s.includes('集中'))return'🎯';if(s.includes('gmail')||s.includes('mail')||s.includes('メール'))return'📩';if(s.includes('calendar')||s.includes('カレンダー'))return'📅';if(s.includes('launch')||s.includes('起動'))return'🚀';if(s.includes('spotify')||s.includes('music')||s.includes('音楽'))return'🎵';if(s.includes('pet')||s.includes('ペット'))return'🐾';if(s.includes('plugin')||s.includes('プラグイン'))return'🧩';if(s.includes('setting')||s.includes('control')||s.includes('設定'))return'⚙️';if(s.includes('hide')||s.includes('隠'))return'👋';return'✦'}
function button(item,kind){const b=document.createElement('button');b.type='button';b.disabled=!item.enabled;b.className=kind==='group'?'card':'action';if(kind==='group'){const icon=document.createElement('span');icon.className='icon';icon.textContent=iconFor(item.label);const text=document.createElement('span');text.className='card-text';text.textContent=item.label;b.append(icon,text)}else{const icon=document.createElement('span');icon.className='mini';icon.textContent=item.checked?'✓':iconFor(item.label);const text=document.createElement('span');text.className='label';text.textContent=item.label;const arrow=document.createElement('span');arrow.className='arrow';arrow.textContent='›';b.append(icon,text,arrow)}b.addEventListener('click',()=>api.select(item.id));return b}
function section(label,items,kind){if(!items.length)return;const h=document.createElement('div');h.className='section-label';h.textContent=label;content.appendChild(h);const wrap=document.createElement('div');wrap.className=kind==='group'?'groups':'actions';for(const item of items)wrap.appendChild(button(item,kind));content.appendChild(wrap)}
function render(model){current=model;title.textContent=model.title||'Menu';back.hidden=!model.canGoBack;content.replaceChildren();section('PLUGINS',model.groups||[],'group');section(model.groups&&model.groups.length?'ACTIONS':'MENU',model.actions||[],'action');if(!(model.groups||[]).length&&!(model.actions||[]).length){const e=document.createElement('div');e.className='empty';e.textContent='使える機能はまだありません。';content.appendChild(e)}}
back.addEventListener('click',()=>api.back());api.onModel(render);window.addEventListener('keydown',(event)=>{if(event.key==='Escape')api.close()});render(current);
</script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
