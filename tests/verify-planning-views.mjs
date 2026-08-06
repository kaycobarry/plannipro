import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const timelineStart = html.indexOf('const DAY_START =');
const timelineEnd = html.indexOf('function renderDayView()', timelineStart);
assert.ok(timelineStart >= 0 && timelineEnd > timelineStart, 'day timeline helpers must exist');
const timeline = {};
vm.runInNewContext(html.slice(timelineStart, timelineEnd), timeline);
assert.equal(timeline.timeToX('00:00'), 0, 'the daily grid starts at midnight');
assert.equal(timeline.timeToX('23:00'), 23 * 80, 'the daily grid includes the final hour');
assert.equal(timeline.xToTime(24 * 80), '23:45', 'a drop at the right edge remains a valid quarter-hour');
assert.match(html, /endMarker\.textContent = '00h'/);
assert.match(html, /const endH\s+= String\(\(h\+8\) % 24\)/);
assert.match(html, /if \(w < 0\) w \+= TOTAL_W/);
assert.match(html, /const newEndStr = String\(hFinal % 24\)/);

const helperStart = html.indexOf('function weekReferenceDay()');
const helperEnd = html.indexOf('function fd(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'weekReferenceDay must exist');

const context = {
  wkDays: () => ['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'],
  today: () => '2026-08-06'
};
vm.runInNewContext(html.slice(helperStart, helperEnd), context);
assert.equal(context.weekReferenceDay(), '2026-11-02', 'an off-screen current date must fall back to the visible week');

context.today = () => '2026-11-05';
assert.equal(context.weekReferenceDay(), '2026-11-05', 'today remains selected when it belongs to the visible week');

assert.match(html, /if \(previousMode === 'week' \|\| !currentDay\) currentDay = weekReferenceDay\(\);/);
assert.match(html, /const refDay = previousMode === 'day' && currentDay \? currentDay : weekReferenceDay\(\);/);
assert.match(html, /currentMonth = \{year: refDate\.getFullYear\(\), month: refDate\.getMonth\(\)\};/);
assert.match(html, /if \(x < 0\)[\s\S]*shiftInner\.style\.transform = 'translateX\('/);

console.log('Planning day/month period synchronization: OK');
