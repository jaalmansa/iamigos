// IAmigos desktop — the strip page: shows the image the main process draws,
// reports clicks (left: jump/whip, right: menu) and drags the window around.
'use strict';

const box = document.getElementById('box');
const img = document.getElementById('strip');
const combo = document.getElementById('combo');
let lastCombo = '';

window.iamigos.onFrame(frame => {
    img.src = frame.url;
    img.style.width = `${frame.width}px`;
    img.style.height = `${frame.height}px`;
    box.style.padding = `${frame.pad - 1}px`;

    const text = frame.combo?.text ?? '';
    combo.style.display = text ? 'block' : 'none';
    if (text) {
        combo.style.left = `${frame.pad + frame.combo.x}px`;
        combo.style.bottom = `${frame.height + 2 * frame.pad + 4}px`;
        combo.className = frame.combo.tier ? `tier-${frame.combo.tier}` : '';
        if (text !== lastCombo) {
            void combo.offsetWidth;             // restart the pop animation
            combo.classList.add(frame.combo.milestone ? 'milestone' : 'pop');
        }
    }
    lastCombo = text;
});

// Only the box takes the mouse; the rest of the window lets clicks through.
box.addEventListener('mouseenter', () => window.iamigos.hover(true));
box.addEventListener('mouseleave', () => window.iamigos.hover(false));

// A press that moves more than a few pixels is a drag; otherwise, a click.
let press = null;
box.addEventListener('pointerdown', e => {
    if (e.button !== 0)
        return;
    box.setPointerCapture(e.pointerId);
    press = {x: e.screenX, y: e.screenY, dragging: false, offset: e.clientX - img.getBoundingClientRect().left};
});
box.addEventListener('pointermove', e => {
    if (!press)
        return;
    if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
        press.dragging = true;
        window.iamigos.dragStart();
    }
    if (press.dragging)
        window.iamigos.dragMove();
});
box.addEventListener('pointerup', () => {
    if (!press)
        return;
    if (press.dragging)
        window.iamigos.dragEnd();
    else
        window.iamigos.click(press.offset, 0);
    press = null;
});
box.addEventListener('contextmenu', e => {
    e.preventDefault();
    window.iamigos.click(e.clientX - img.getBoundingClientRect().left, 2);
});
