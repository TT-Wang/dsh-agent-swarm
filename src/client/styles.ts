/** Scoped styles keep the monitor independent of the host's theme implementation. */
export const SWARM_CSS = `
[data-swarm] .sw-auto-start { margin:12px 0; padding:12px; border:1px solid var(--sw-line); border-radius:10px; }
[data-swarm] .sw-auto-start p { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
[data-swarm] .sw-table-wrap { overflow-x:auto; }
[data-swarm] table.sw-usage { border-collapse:collapse; font-size:12px; width:100%; }
[data-swarm] table.sw-usage th, [data-swarm] table.sw-usage td { padding:4px 8px; text-align:right; border-bottom:1px solid var(--sw-border); white-space:nowrap; }
[data-swarm] table.sw-usage th[scope=row] { text-align:left; font-weight:600; }

[data-swarm]{--sw-line:#2b414b;--sw-bg:#101b22;--sw-card:#162630;--sw-border:#2b414b;--sw-text:#e9f1f3;--sw-muted:#a0b7bf;--sw-accent:#76dcc8;color:var(--sw-text);background:var(--sw-bg);border:1px solid var(--sw-border);border-radius:16px;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;overflow:hidden;margin:12px 0;max-width:100%;color-scheme:dark}
[data-swarm] *{box-sizing:border-box}[data-swarm] button{font:inherit;color:inherit;cursor:pointer}[data-swarm] button:focus-visible,[data-swarm] summary:focus-visible{outline:2px solid var(--sw-accent);outline-offset:3px}[data-swarm] .sw-head{padding:22px 24px 16px;background:linear-gradient(135deg,#173630 0%,#13232c 75%)}
[data-swarm] .sw-eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);font-weight:700}[data-swarm] h2{font-size:22px;line-height:1.2;letter-spacing:-.03em;margin:8px 0 9px;font-weight:650}[data-swarm] h3{font-size:13px;margin:0 0 10px;font-weight:650}[data-swarm] p{margin:0}[data-swarm] .sw-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}[data-swarm] .sw-muted{color:var(--sw-muted)}[data-swarm] .sw-objective{max-width:85ch;color:#bed0d5;font-size:12px;overflow-wrap:anywhere}[data-swarm] .sw-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--sw-border);border-radius:100px;padding:3px 8px;font-size:10px;white-space:nowrap;line-height:1.4;background:#1b2b33;color:#c5d7dc}[data-swarm] .sw-chip[data-tone=good]{background:#173e33;border-color:#366857;color:#a1ebc5}[data-swarm] .sw-chip[data-tone=warn]{background:#493b20;border-color:#73612d;color:#f4d28c}[data-swarm] .sw-chip[data-tone=bad]{background:#462b32;border-color:#78414c;color:#ffc1c5}[data-swarm] .sw-chip[data-tone=live]{background:#173f46;border-color:#347681;color:#9ee6ec}
[data-swarm] .sw-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--sw-border);border-bottom:1px solid var(--sw-border)}[data-swarm] .sw-metric{background:#13212a;padding:15px 18px}[data-swarm] .sw-metric strong{display:block;font-size:19px;line-height:1.2;font-weight:600}[data-swarm] .sw-metric label{font-size:10px;color:var(--sw-muted);display:block;margin-bottom:6px}[data-swarm] .sw-metric small{font-size:10px;color:var(--sw-muted)}[data-swarm] .sw-meter{height:3px;background:#2a3e47;border-radius:3px;margin-top:9px;overflow:hidden}[data-swarm] .sw-meter span{display:block;height:100%;background:var(--sw-accent)}
[data-swarm] .sw-tabs{display:flex;gap:4px;padding:12px 18px;border-bottom:1px solid var(--sw-border);flex-wrap:wrap}[data-swarm] .sw-tab{background:transparent;border:0;padding:7px 12px;border-radius:7px;color:var(--sw-muted)}[data-swarm] .sw-tab[aria-selected=true]{background:#273d43;color:#b9f4dd}[data-swarm] .sw-body{padding:18px}[data-swarm] .sw-streams{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}[data-swarm] .sw-stream{background:transparent;border:1px solid var(--sw-border);border-radius:6px;padding:5px 9px;font-size:11px}[data-swarm] .sw-stream[aria-pressed=true]{background:#234239;border-color:#558b74;color:#bbedce}
[data-swarm] .sw-board{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:10px;overflow-x:auto;padding-bottom:10px}[data-swarm] .sw-lane{min-width:0}[data-swarm] .sw-lane-title{display:flex;align-items:center;justify-content:space-between;font-size:10px;font-weight:600;color:var(--sw-muted);margin-bottom:9px;padding:0 3px;min-height:28px}[data-swarm] .sw-count{display:inline-block;background:#263942;border-radius:4px;min-width:20px;text-align:center;padding:1px 4px}[data-swarm] .sw-task{border:1px solid var(--sw-border);background:var(--sw-card);padding:12px;border-radius:9px;margin-bottom:8px;overflow-wrap:anywhere}[data-swarm] .sw-task[data-lane=active]{border-top:2px solid #77d5c6}[data-swarm] .sw-task[data-lane=blocked]{border-top:2px solid #c69072}[data-swarm] .sw-task-title{font-size:12px;line-height:1.45;font-weight:600;margin:7px 0 9px}[data-swarm] .sw-task-meta{font-size:10px;color:var(--sw-muted);display:flex;flex-direction:column;gap:4px}[data-swarm] .sw-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px}[data-swarm] .sw-empty{padding:18px 10px;border:1px dashed #2c414a;border-radius:8px;color:#8ba1aa;font-size:11px;text-align:center}[data-swarm] .sw-section{margin-top:22px}[data-swarm] .sw-workers{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}[data-swarm] .sw-worker{background:#14242b;border:1px solid var(--sw-border);padding:12px;border-radius:9px}[data-swarm] .sw-worker-name{font-weight:600;font-size:12px}[data-swarm] .sw-avatar{width:28px;height:28px;border-radius:8px;background:#2c534b;display:inline-flex;align-items:center;justify-content:center;color:#b6ead8;font-size:11px;margin-right:9px;flex-shrink:0}[data-swarm] .sw-person{display:flex;align-items:center;min-width:0}[data-swarm] .sw-small{font-size:10px;color:var(--sw-muted)}
[data-swarm] .sw-evidence{border:1px solid var(--sw-border);border-radius:10px;padding:15px;margin-bottom:10px;background:var(--sw-card)}[data-swarm] .sw-claim{font-size:13px;margin:9px 0 12px;overflow-wrap:anywhere}[data-swarm] .sw-provenance{display:flex;gap:7px;flex-wrap:wrap;font-size:10px;color:var(--sw-muted)}[data-swarm] details{margin-top:10px}[data-swarm] summary{cursor:pointer;font-size:11px;color:#aed9d0}[data-swarm] .sw-challenge{margin-top:9px;padding:10px;border-left:2px solid #d9af66;background:#2b2b27;font-size:11px;overflow-wrap:anywhere}[data-swarm] .sw-refs{font-size:10px;margin-top:7px;word-break:break-all;color:var(--sw-muted)}[data-swarm] .sw-event{display:grid;grid-template-columns:62px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid #243842}[data-swarm] .sw-event-type{font-size:12px}[data-swarm] .sw-event-data{font-size:10px;color:var(--sw-muted);overflow-wrap:anywhere;margin-top:3px}[data-swarm] .sw-foot{padding:12px 18px;border-top:1px solid var(--sw-border);font-size:10px;color:var(--sw-muted);display:flex;justify-content:space-between;gap:9px;flex-wrap:wrap}[data-swarm] .sw-notice{border-left:3px solid #d6ad73;background:#302e25;padding:10px 13px;margin-bottom:15px;font-size:12px;color:#f0d9b3;overflow-wrap:anywhere}[data-swarm] .sw-contract{display:grid;grid-template-columns:1fr 1fr;gap:18px;font-size:11px;color:var(--sw-muted)}[data-swarm] .sw-contract ul{padding-left:18px;margin:6px 0}
@media(max-width:700px){[data-swarm] .sw-head{padding:18px}[data-swarm] h2{font-size:19px}[data-swarm] .sw-metrics{grid-template-columns:repeat(2,1fr)}[data-swarm] .sw-body{padding:14px}[data-swarm] .sw-board{grid-template-columns:repeat(7,172px)}[data-swarm] .sw-contract{grid-template-columns:1fr}}
[data-swarm-panel]{pointer-events:auto;margin:0;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;border:0;border-radius:0;container-type:inline-size}
[data-swarm-panel] .sw-panel-title{display:flex;align-items:center;justify-content:space-between;background:var(--sw-card);padding:12px 16px;flex:none;user-select:none;border-bottom:1px solid var(--sw-border)}
[data-swarm-panel] .sw-panel-title>div:first-child{min-width:0;overflow:hidden}[data-swarm-panel] .sw-panel-title strong{font-size:13px;letter-spacing:.01em}[data-swarm-panel] .sw-panel-title small{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--sw-muted);max-width:48ch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.sw-live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#65cfb0;flex:none}.sw-live-dot[data-error=true]{background:#d9ad69}
/* C3: the host root is resized inline by SidebarDock.dockShift, so this sheet
   names no host id and needs no !important; the dock's own geometry stays here. */
[data-swarm-dock]{position:fixed;inset:0 0 0 auto;width:var(--swarm-dock-width);height:100dvh;pointer-events:auto;border-left:1px solid #90a79c55;background:#f6faf8;z-index:40}
body[data-ds-dark-theme] [data-swarm-dock]{background:#101b22}
.sw-dock-body{height:100%;min-height:0}.sw-dock-body[hidden],.sw-launcher[hidden]{display:none}
.sw-launcher{width:100%;height:100%;display:flex;align-items:center;justify-content:flex-start;gap:12px;writing-mode:vertical-rl;background:transparent;color:inherit;border:0;padding:18px 3px;font:600 11px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.sw-launcher:focus-visible{outline:2px solid #559b7c;outline-offset:-3px}
.sw-sidebar-resize{position:absolute;inset:0 auto 0 -3px;width:7px;cursor:col-resize;touch-action:none;z-index:2}
.sw-sidebar-resize:hover,.sw-sidebar-resize:focus-visible{background:#68bca66b;outline:none}
@media(max-width:700px){
[data-swarm-dock]{inset:auto 0 0;width:100%;height:45dvh;border-left:0;border-top:1px solid #90a79c55}[data-swarm-dock][data-expanded=false]{height:40px}.sw-launcher{writing-mode:horizontal-tb;justify-content:center;padding:8px}.sw-sidebar-resize{display:none}}

/* The rail glyph renders inside the host's sidebar column, so it is not scoped
   under [data-swarm]; it inherits the column's colour and only fixes its box. */
.sw-rail-icon{display:block;flex:none}
.sw-open-monitor{border:1px solid #507c70;border-radius:7px;background:transparent;color:inherit;font:12px ui-sans-serif,system-ui,sans-serif;padding:6px 10px;cursor:pointer}
[data-swarm-panel] .sw-panel-buttons{display:flex;gap:5px}[data-swarm-panel] .sw-panel-buttons button{width:29px;height:29px;padding:0;font-size:20px;background:transparent;border-color:transparent}
[data-swarm-panel] .sw-panel-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:10px 12px;border-bottom:1px solid var(--sw-border)}
[data-swarm-panel] .sw-panel-toolbar select{flex:1 1 180px;min-width:0}[data-swarm-panel] .sw-panel-content{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain;padding:0 12px 18px}[data-swarm-panel] .sw-panel-content>[data-swarm]{margin:8px 0 0;border:0;border-radius:10px}
[data-swarm-panel] button,[data-swarm-panel] select,[data-swarm-panel] input,[data-swarm-panel] textarea{font:inherit;color:var(--sw-text);background:var(--sw-card);border:1px solid var(--sw-border);border-radius:6px;padding:7px 9px;max-width:100%}
[data-swarm-panel] button{white-space:nowrap;font-size:11px}[data-swarm-panel] button:hover{border-color:var(--sw-accent)}[data-swarm-panel] button:disabled{opacity:.45;cursor:not-allowed}[data-swarm-panel] input:focus-visible,[data-swarm-panel] select:focus-visible,[data-swarm-panel] textarea:focus-visible{outline:2px solid var(--sw-accent);outline-offset:1px}
[data-swarm] .sw-link{background:transparent;border:0;padding:5px 0;color:var(--sw-accent);font-size:11px;cursor:pointer;margin-top:8px}[data-swarm-panel] .sw-primary{background:#2c6b56;color:#e9fff6;border-color:#4a9777}
[data-swarm] .sw-mission-controls{display:flex;align-items:center;gap:8px;padding:10px 4px 0;flex-wrap:wrap}
/* OWNER PASS 2026-09-11 #2: one horizontal row for the mission controls —
   Pause/Resume beside Stop/Complete — instead of two stacked clusters. The row
   never wraps; when the panel is narrower than the buttons it scrolls sideways. */
[data-swarm] .sw-actions{display:flex;align-items:flex-start;gap:10px;flex-wrap:nowrap;overflow-x:auto;padding:2px 0;scrollbar-width:thin}
[data-swarm] .sw-actions>.sw-mission-controls{padding:0;flex:0 0 auto;flex-wrap:nowrap;align-items:flex-start}
[data-swarm] .sw-actions>.sw-mission-controls>button{flex:0 0 auto}
[data-swarm] .sw-complete-control{display:flex;flex-direction:column;align-items:flex-start;gap:3px;flex:0 0 auto;min-width:0}
[data-swarm] .sw-complete-control>[data-swarm-completion]{max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
@container(max-width:400px){[data-swarm] .sw-actions{gap:6px}[data-swarm] .sw-actions button{padding:6px 8px}[data-swarm] .sw-complete-control>[data-swarm-completion]{max-width:150px}}
[data-swarm] .sw-delivery{border:1px solid var(--sw-border);border-radius:8px;margin:12px 0;padding:12px;font-size:12px;overflow-wrap:anywhere}
[data-swarm] .sw-delivery .sw-controls{display:flex;gap:8px;align-items:center;flex-wrap:nowrap;overflow-x:auto}
[data-swarm] .sw-delivery-diff{max-height:360px;overflow:auto;font-size:11px;white-space:pre;tab-size:2}
[data-swarm] .sw-error{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;background:#482c30;border:1px solid #8f5c60;color:#ffd7d6;border-radius:7px;padding:10px 12px;margin:10px 0}
[data-swarm] .sw-editor{padding:16px 6px 6px}[data-swarm] .sw-editor h2{font-size:18px}[data-swarm] fieldset{margin:0;padding:0;border:0;min-width:0}[data-swarm] .sw-editor label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--sw-muted);margin-top:12px;min-width:0}[data-swarm] .sw-editor label input,[data-swarm] .sw-editor label textarea,[data-swarm] .sw-editor label select{display:block;width:100%;font-size:12px}[data-swarm] .sw-editor textarea{resize:vertical;min-height:65px;line-height:1.5}[data-swarm] .sw-editor input[readonly]{opacity:.6}
[data-swarm] .sw-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}[data-swarm] .sw-budget-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px}[data-swarm] .sw-edit-item{padding:12px;border:1px solid var(--sw-border);border-radius:9px;margin-top:10px;background:var(--sw-bg)}[data-swarm] .sw-edit-item>.sw-row{margin-top:5px}[data-swarm] .sw-edit-item code{font-size:10px;color:var(--sw-muted)}
[data-swarm] .sw-prereqs{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--sw-muted)}[data-swarm] .sw-prereqs>span{width:100%}[data-swarm] .sw-prereqs label{flex-direction:row;align-items:center;margin:0}[data-swarm] .sw-prereqs label input{width:auto}
[data-swarm] .sw-editor-actions{position:sticky;bottom:-18px;padding:12px 0;background:var(--sw-bg);border-top:1px solid var(--sw-border);margin-top:20px;z-index:2}[data-swarm] .sw-editor-actions p{margin-bottom:9px}

[data-swarm] .sw-graph-scroll{overflow:auto;border:1px solid var(--sw-border);border-radius:10px;margin-bottom:12px}[data-swarm] .sw-graph{position:relative}[data-swarm] .sw-graph svg{position:absolute;top:0;left:0;color:#668e8a;pointer-events:none}[data-swarm] .sw-graph-node{position:absolute;width:194px;height:77px;padding:10px;text-align:left;border:1px solid var(--sw-border);border-radius:8px;background:var(--sw-card);white-space:normal;overflow:hidden}[data-swarm] .sw-graph-node small{display:block;color:var(--sw-muted);font-size:9px;margin-bottom:5px}[data-swarm] .sw-graph-node strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.3}[data-swarm] .sw-graph-node[aria-pressed=true]{outline:2px solid var(--sw-accent)}[data-swarm] .sw-graph-node[data-lane=active]{border-top:3px solid #65cfb0}[data-swarm] .sw-graph-node[data-lane=blocked]{border-top:3px solid #d9ad69}[data-swarm] .sw-graph-node[data-lane=done]{border-top:3px solid #80a3c4}[data-swarm] .sw-graph-detail{padding:12px;background:var(--sw-card);border-radius:9px;font-size:11px}[data-swarm] .sw-graph-detail p{margin-top:6px;color:var(--sw-muted);white-space:pre-wrap}
@media(max-width:600px){[data-swarm-panel] .sw-panel-toolbar{flex-wrap:wrap}[data-swarm-panel] .sw-panel-toolbar select{flex-basis:100%}[data-swarm] .sw-fields{grid-template-columns:1fr}[data-swarm] .sw-budget-fields{grid-template-columns:repeat(2,minmax(0,1fr))}[data-swarm-panel] .sw-panel-title small{max-width:26ch}[data-swarm-panel] .sw-panel-content{padding:0 8px 18px}}
body:not([data-ds-dark-theme]) [data-swarm]{--sw-line:#d4e1dc;--sw-bg:#f7faf9;--sw-card:#fff;--sw-border:#d4e1dc;--sw-text:#20352e;--sw-muted:#607a70;--sw-accent:#24735a;color-scheme:light}
body:not([data-ds-dark-theme]) [data-swarm] .sw-head{background:linear-gradient(135deg,#e0f1e8,#f2f7f5)}body:not([data-ds-dark-theme]) [data-swarm] .sw-objective{color:var(--sw-muted)}body:not([data-ds-dark-theme]) [data-swarm] .sw-metric,body:not([data-ds-dark-theme]) [data-swarm] .sw-worker{background:var(--sw-card)}
body:not([data-ds-dark-theme]) [data-swarm] .sw-chip{background:#edf2ef;color:#476357}body:not([data-ds-dark-theme]) [data-swarm] .sw-chip[data-tone=good]{background:#e4f4e8;border-color:#a3c7ad;color:#276446}body:not([data-ds-dark-theme]) [data-swarm] .sw-chip[data-tone=live]{background:#e1f0f1;border-color:#a7cbce;color:#2d696f}body:not([data-ds-dark-theme]) [data-swarm] .sw-chip[data-tone=warn]{background:#f8eedb;border-color:#dbc698;color:#8b681e}body:not([data-ds-dark-theme]) [data-swarm] .sw-chip[data-tone=bad]{background:#f8e9e7;border-color:#dcaaa4;color:#954b45}
body:not([data-ds-dark-theme]) [data-swarm] .sw-tab[aria-selected=true],body:not([data-ds-dark-theme]) [data-swarm] .sw-stream[aria-pressed=true]{background:#e1eee6;color:#285e48}body:not([data-ds-dark-theme]) [data-swarm] .sw-count,body:not([data-ds-dark-theme]) [data-swarm] .sw-meter{background:#e0e9e4}body:not([data-ds-dark-theme]) [data-swarm] .sw-empty{border-color:#c4d6cc;color:#6b8275}body:not([data-ds-dark-theme]) [data-swarm] summary{color:#3d7360}
body:not([data-ds-dark-theme]) [data-swarm] .sw-challenge,body:not([data-ds-dark-theme]) [data-swarm] .sw-notice{background:#fbf3e4;color:#765e31}body:not([data-ds-dark-theme]) [data-swarm] .sw-event{border-color:var(--sw-border)}body:not([data-ds-dark-theme]) [data-swarm] .sw-error{background:#fbebeb;color:#8b4242;border-color:#dbb2b2}
[data-swarm] .sw-transcript{padding:16px 4px}[data-swarm] .sw-transcript-entry{margin:12px 0;padding:12px;border:1px solid var(--sw-border);border-radius:8px;background:var(--sw-card)}[data-swarm] .sw-transcript-entry strong{font-size:11px}[data-swarm] .sw-transcript-entry pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,SFMono-Regular,monospace;margin:9px 0 0;max-height:500px;overflow:auto}
@container(max-width:540px){[data-swarm-panel] .sw-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}[data-swarm-panel] .sw-head{padding:16px}[data-swarm-panel] h2{font-size:19px}[data-swarm-panel] .sw-body{padding:12px}[data-swarm-panel] .sw-board{grid-template-columns:minmax(0,1fr);overflow:visible}[data-swarm-panel] .sw-lane-title{min-height:20px;margin-bottom:5px}[data-swarm-panel] .sw-empty{padding:9px}[data-swarm-panel] .sw-contract,[data-swarm-panel] .sw-fields{grid-template-columns:minmax(0,1fr)}[data-swarm-panel] .sw-budget-fields{grid-template-columns:repeat(2,minmax(0,1fr))}[data-swarm-panel] .sw-tabs{padding:10px 8px;gap:2px}[data-swarm-panel] .sw-tab{padding:6px 8px}[data-swarm-panel] .sw-workers{grid-template-columns:minmax(0,1fr)}}

/* The first view answers what is happening; the existing engineering views remain disclosures. */
[data-swarm] .sw-head{background:none!important;padding:18px 18px 0}[data-swarm] .sw-head h2{font-size:18px;line-height:1.45;font-weight:550;letter-spacing:normal;overflow-wrap:anywhere;margin:10px 0 0}
[data-swarm] .sw-overview{padding:15px 18px 0}[data-swarm] .sw-focus{padding:14px;background:var(--sw-card);border:1px solid var(--sw-border);border-radius:9px;margin-bottom:16px;overflow-wrap:anywhere}
[data-swarm] .sw-focus>strong{display:block;font-size:14px;font-weight:550;margin-bottom:5px}[data-swarm] .sw-focus>small{display:block;color:var(--sw-muted);font-size:11px;margin-bottom:6px}[data-swarm] .sw-focus-note{color:var(--sw-muted);font-size:11px;margin-top:7px}
[data-swarm] .sw-focus[data-stale=true]{border-style:dashed}[data-swarm] .sw-recent{margin:16px 0 8px}[data-swarm] .sw-recent h3{margin:0;font-size:12px;font-weight:550}[data-swarm] .sw-accepted-count{font-size:11px;color:var(--sw-muted)}
[data-swarm] .sw-recent ol{list-style:none;margin:8px 0 0;padding:0}[data-swarm] .sw-recent li{display:grid;grid-template-columns:66px minmax(0,1fr);gap:10px;padding:9px 0}[data-swarm] .sw-recent time{font-size:10px;color:var(--sw-muted);padding-top:2px;font-variant-numeric:tabular-nums}
[data-swarm] .sw-recent li p{font-size:12px;overflow-wrap:anywhere}[data-swarm] .sw-recent li small{display:block;font-size:11px;color:var(--sw-muted);margin-top:3px;overflow-wrap:anywhere}
[data-swarm] .sw-disclosure{border-top:1px solid var(--sw-border);margin:0;padding:12px 0}[data-swarm] .sw-disclosure>summary{font-size:12px;color:var(--sw-muted);line-height:1.6}[data-swarm] .sw-detail-count{font-size:11px;margin-left:6px;color:var(--sw-muted)}
[data-swarm] .sw-disclosure>.sw-workers{margin-top:12px}[data-swarm] .sw-technical{margin:0 18px}[data-swarm] .sw-detail-objective{padding:12px 0}[data-swarm] .sw-technical .sw-metrics{border:1px solid var(--sw-border);border-radius:8px;overflow:hidden}
[data-swarm] .sw-technical .sw-body{padding:14px 0}[data-swarm] .sw-technical .sw-tabs{padding:12px 0}[data-swarm] .sw-technical>.sw-mission-controls{padding:12px 0}
[data-swarm] .sw-result-summary{padding:14px;border:1px solid var(--sw-border);border-radius:9px;margin-bottom:14px}[data-swarm] .sw-result-summary h3{font-size:13px;font-weight:550;margin-bottom:9px}[data-swarm] .sw-result-summary strong{font-size:12px;font-weight:550}
[data-swarm] .sw-result-summary p{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}[data-swarm] .sw-result-summary>div{margin:10px 0}[data-swarm] .sw-delivery p{margin:8px 0;color:var(--sw-muted)}
[data-swarm] .sw-delivery .sw-controls{margin-top:12px}[data-swarm] .sw-mission-controls{padding:0;min-height:0}[data-swarm] .sw-start-guide{padding:22px 6px 18px;line-height:1.7}[data-swarm] .sw-start-guide h2{font-size:18px;margin:0 0 14px;font-weight:550;overflow-wrap:anywhere}
[data-swarm] .sw-start-guide p{font-size:12px;margin:9px 0;color:var(--sw-muted)}[data-swarm] .sw-start-guide code{display:block;padding:12px;border:1px solid var(--sw-border);border-radius:7px;background:var(--sw-card);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
[data-swarm] .sw-connection-note{font-size:11px;color:var(--sw-muted);margin:12px 0}[data-swarm] .sw-live-dot[data-connection=connecting],[data-swarm] .sw-live-dot[data-connection=paused]{background:var(--sw-muted)}[data-swarm] .sw-live-dot[data-connection=reconnecting]{background:#c69b48}
[data-swarm] .sw-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@container(max-width:380px){[data-swarm-panel] .sw-overview{padding:14px 12px 0}[data-swarm-panel] .sw-technical{margin:0 12px}[data-swarm-panel] .sw-head{padding:16px 12px 0}[data-swarm-panel] .sw-recent li{grid-template-columns:58px minmax(0,1fr);gap:7px}}
@media(pointer:coarse){[data-swarm-panel] button,[data-swarm-panel] select,[data-swarm] .sw-disclosure>summary{min-height:44px}[data-swarm] .sw-disclosure>summary{padding-top:10px}}

/* OWNER PASS 2026-09-11: the team strip, the per-member progress bar, the seven
   lanes and the cancellation cause chips. */
[data-swarm] .sw-team{margin:0 0 16px}[data-swarm] .sw-team h3{margin:0;font-size:12px;font-weight:550}
[data-swarm] .sw-team .sw-workers{margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
/* OWNER PASS 2026-09-11 #2: the member card is a two-column head (avatar +
   identity), a full-width task line, the progress bar and the metadata/link rows,
   so the sprite reads as the card's anchor instead of a thumbnail in the name line. */
[data-swarm] .sw-member{display:block}
[data-swarm] .sw-member-head{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}
[data-swarm] .sw-member-ident{min-width:0}
[data-swarm] .sw-member-name{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
[data-swarm] .sw-member-name .sw-worker-name{font-size:14px;font-weight:600;overflow-wrap:anywhere}
[data-swarm] .sw-member-role{margin-top:3px}
[data-swarm] .sw-member-task{font-size:12px;color:var(--sw-text);overflow-wrap:anywhere;margin-top:10px}
[data-swarm] .sw-member .sw-bar{margin-top:10px}
[data-swarm] .sw-member .sw-link{margin-top:12px}
[data-swarm] .sw-member-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--sw-muted);margin-top:9px}
[data-swarm] .sw-member-meta>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
[data-swarm] .sw-bar{height:4px;border-radius:4px;background:#2a3e47;overflow:hidden;position:relative}
[data-swarm] .sw-bar>span{display:block;height:100%;background:var(--sw-accent);transition:width .6s ease}
[data-swarm] .sw-bar[data-basis=lease]>span{background:#8fc9d8}
[data-swarm] .sw-bar[data-indeterminate]>span{width:38%;background:linear-gradient(90deg,transparent,var(--sw-accent),transparent);animation:sw-slide 1.4s ease-in-out infinite}
[data-swarm] .sw-bar[data-state=stopped]{opacity:.4}[data-swarm] .sw-bar[data-state=stopped]>span{animation:none;width:0}
[data-swarm] .sw-bar[data-state=waiting]>span{background:#d9ad69;animation:none;width:100%;opacity:.5}
[data-swarm] .sw-bar[data-state=idle]>span{animation:none;width:0}
@keyframes sw-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
@media(prefers-reduced-motion:reduce){[data-swarm] .sw-bar[data-indeterminate]>span{animation:none;width:100%;opacity:.35}[data-swarm] .sw-bar>span{transition:none}}
[data-swarm] .sw-member .sw-worker-avatar{width:48px;height:48px;border-radius:11px;background:#0d1a20;padding:3px;flex:none}
body:not([data-ds-dark-theme]) [data-swarm] .sw-member .sw-worker-avatar{background:#eef4f1}
[data-swarm] .sw-cancel-note{color:#d9b48c;margin-top:5px}
body:not([data-ds-dark-theme]) [data-swarm] .sw-cancel-note{color:#8a6a3d}
[data-swarm] .sw-task[data-lane=queued]{border-top:2px solid #6f8fb0}
[data-swarm] .sw-task[data-lane=cancelled]{border-top:2px solid #6d6f7a;opacity:.85}
[data-swarm] .sw-task[data-lane=review]{border-top:2px solid #b6a2d8}
[data-swarm] .sw-lane[data-lane=blocked] .sw-lane-title{color:#dba97f}
[data-swarm] .sw-lane[data-lane=cancelled] .sw-lane-title{color:#9aa0ad}
[data-swarm] .sw-lane[data-lane=queued] .sw-lane-title{color:#9db6d4}
[data-swarm] .sw-mission-facts{margin-top:12px;border-top:1px solid var(--sw-border);padding-top:10px}
[data-swarm] .sw-mission-facts>summary{display:flex;gap:9px;flex-wrap:wrap;align-items:baseline}
[data-swarm] .sw-fact-title{font-size:12px;color:var(--sw-text)}
[data-swarm] .sw-fact-counts{color:var(--sw-muted)}

/* OWNER PASS 2026-09-11 (second pass): lane counts, collapsed empty lanes, the
   member-grouped activity feed, the clamped card reason and the state
   provenance line. */
[data-swarm] .sw-lane-counts{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
[data-swarm] .sw-lane-count{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--sw-border);border-radius:100px;padding:2px 8px;font-size:10px;color:var(--sw-muted);background:#1b2b33}
[data-swarm] .sw-lane-count b{font-weight:600;color:var(--sw-text)}
[data-swarm] .sw-lane-count[data-empty=true]{opacity:.5}
body:not([data-ds-dark-theme]) [data-swarm] .sw-lane-count{background:#eef3f0}
[data-swarm] .sw-lane[data-empty]{opacity:.55;align-self:start}
[data-swarm] .sw-lane[data-empty] .sw-lane-title{margin-bottom:0;min-height:0;padding-bottom:0}
[data-swarm] .sw-lane-void{border-top:1px dashed #2c414a;margin-top:2px}
[data-swarm] .sw-activity-group{border-top:1px solid var(--sw-border);padding-top:10px;margin-top:10px}
[data-swarm] .sw-activity-group:first-of-type{border-top:0;padding-top:0;margin-top:0}
[data-swarm] .sw-activity-head{margin-bottom:4px}
[data-swarm] .sw-activity-head .sw-person{gap:8px;align-items:center;min-width:0}
[data-swarm] .sw-activity-head strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}
[data-swarm] .sw-activity-head .sw-worker-avatar{width:28px;height:28px;border-radius:7px;background:#0d1a20;padding:2px;flex:none}
body:not([data-ds-dark-theme]) [data-swarm] .sw-activity-head .sw-worker-avatar{background:#eef4f1}
[data-swarm] .sw-actor-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4d7d92;flex:none}
[data-swarm] .sw-activity-group .sw-event:last-child{border-bottom:0}
[data-swarm] .sw-reason{font-size:10px;color:var(--sw-muted)}
[data-swarm] .sw-reason>summary{color:#d9b48c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
body:not([data-ds-dark-theme]) [data-swarm] .sw-reason>summary{color:#8a6a3d}
[data-swarm] .sw-reason>p{margin-top:6px;overflow-wrap:anywhere}
[data-swarm] .sw-why{margin-top:9px}
[data-swarm] .sw-why>summary{font-size:11px;color:var(--sw-muted)}
[data-swarm] .sw-why .sw-focus-note{margin-top:5px}
[data-swarm] .sw-decision-content{display:block;margin-top:3px}
`