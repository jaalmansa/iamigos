// IAmigos desktop — the strip page's only way to talk to the main process.
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('iamigos', {
    onFrame: fn => ipcRenderer.on('strip:frame', (_e, frame) => fn(frame)),
    click: (x, button) => ipcRenderer.send('strip:click', x, button),
    hover: over => ipcRenderer.send('strip:hover', over),
    dragStart: () => ipcRenderer.send('strip:drag-start'),
    dragMove: () => ipcRenderer.send('strip:drag-move'),
    dragEnd: () => ipcRenderer.send('strip:drag-end'),
});
