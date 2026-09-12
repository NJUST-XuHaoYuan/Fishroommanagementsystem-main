import test from 'node:test';
import assert from 'node:assert/strict';
import { rankDashboardSalespeople, dashboardSalespersonSelection } from './dashboardSalespeople.ts';

const options = [10, 70, 30, 40, 60, 20, 50].map((amount, index) => ({ name: `人员${index + 1}`, amount, orderCount: 1 }));
test('defaults to the five highest amounts in the supplied range, without mutating options', () => {
  assert.deepEqual(dashboardSalespersonSelection(options, null), ['人员2', '人员5', '人员7', '人员4', '人员3']);
  assert.equal(options[0].name, '人员1');
});
test('a changed range recalculates top five; people without orders are not defaults', () => {
  const newRange = options.map((option) => ({ ...option, amount: option.name === '人员1' ? 500 : 0, orderCount: option.name === '人员1' ? 1 : 0 }));
  assert.deepEqual(dashboardSalespersonSelection(newRange, null), ['人员1']);
  assert.deepEqual(dashboardSalespersonSelection([], null), []);
});
test('manual selection adds people, drops removed names, and clearing does not select everyone', () => {
  const manual = new Set([...dashboardSalespersonSelection(options, null), '人员1', '已删除人员']);
  assert.equal(dashboardSalespersonSelection(options, manual).length, 6);
  assert.deepEqual(dashboardSalespersonSelection(options, new Set()), []);
});
test('equal totals have deterministic name ordering, regardless of input ordering', () => {
  const tied = options.map((option) => ({ ...option, amount: 100 }));
  assert.deepEqual(rankDashboardSalespeople(tied), rankDashboardSalespeople([...tied].reverse()));
});
