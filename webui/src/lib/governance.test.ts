import { describe, expect, it } from 'vitest';
import {
  actorDisplay, can, transitionIntent, truncateCommand,
} from './governance';

describe('受约束迁移（拖拽 = 状态机语义）', () => {
  it('pending → approved/rejected 是仅有的两条合法拖拽迁移', () => {
    expect(transitionIntent('pending', 'approved')).toEqual({ kind: 'approve' });
    expect(transitionIntent('pending', 'rejected')).toEqual({ kind: 'reject' });
  });

  it('其余落点一律非法（回弹）', () => {
    expect(transitionIntent('pending', 'success')).toBeNull();
    expect(transitionIntent('pending', 'executing')).toBeNull();
    expect(transitionIntent('approved', 'success')).toBeNull();
    expect(transitionIntent('executing', 'failed')).toBeNull();
    expect(transitionIntent('success', 'pending')).toBeNull();
  });
});

describe('角色能力门禁（UI 投影，服务端复核）', () => {
  it('viewer ⊂ operator ⊂ approver ⊂ admin 严格递增', () => {
    expect(can('viewer', 'read')).toBe(true);
    expect(can('viewer', 'action:approve')).toBe(false);
    expect(can('operator', 'action:create')).toBe(true);
    expect(can('operator', 'action:approve')).toBe(false);
    expect(can('approver', 'action:approve')).toBe(true);
    expect(can('approver', 'users:manage')).toBe(false);
    expect(can('admin', 'users:manage')).toBe(true);
  });

  it('未知能力一律拒绝', () => {
    expect(can('admin', 'super:pwn')).toBe(false);
  });
});

describe('命令截断纪律（红队 U1：截断必提示）', () => {
  it('超长命令截断并标记提示', () => {
    const long = 'x'.repeat(100);
    const result = truncateCommand(long);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(61);
  });

  it('短命令原样返回不标记', () => {
    const result = truncateCommand('uptime');
    expect(result).toEqual({ text: 'uptime', truncated: false });
  });

  it('多行命令压单行展示', () => {
    const result = truncateCommand('line1\nline2');
    expect(result.text).toBe('line1 line2');
  });
});

describe('发起者显示名（红队 U2：名字优先）', () => {
  it('agent 显示名字，缺名字回退 ID', () => {
    expect(actorDisplay('agent', 'rt-med', 'agt_1')).toBe('rt-med');
    expect(actorDisplay('agent', undefined, 'agt_1')).toBe('agt_1');
  });

  it('human 显示 actorId（即用户名）', () => {
    expect(actorDisplay('human', undefined, 'ops-admin')).toBe('ops-admin');
  });
});
