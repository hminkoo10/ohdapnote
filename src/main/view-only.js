'use strict';
const message = '보기 전용이라 고칠 수 없어요.';
const blocked = new Set([
  'books:create', 'books:save', 'books:saveSync', 'books:delete', 'books:copy', 'books:setShared', 'books:renameItems',
  'files:import', 'files:photo', 'files:commit', 'files:discard',
  'answers:save', 'answers:saveSync', 'answers:putImage',
  'notes:create', 'notes:save', 'notes:saveSync', 'notes:delete',
  'students:save', 'students:delete', 'students:restore',
]);
function guard(viewOnly, channel, fn) {
  return (...args) => {
    if (viewOnly && blocked.has(channel)) throw new Error(message);
    if (viewOnly && channel === 'books:saveTranscripts') return true;
    return fn(...args);
  };
}
module.exports = { blocked, guard, message };
