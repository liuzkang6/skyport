/** 看板页：轮询（可见 8s / 失败退避 30s）+ 看板 + 详情抽屉 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { Board } from '../components/Board';
import { DetailDrawer } from '../components/DetailDrawer';
import type { ApiAction } from '../api/types';

const POLL_MS = 8_000;
const POLL_BACKOFF_MS = 30_000;

export function BoardPage() {
  const refreshBoard = useApp((s) => s.refreshBoard);
  const boardError = useApp((s) => s.boardError);
  const user = useApp((s) => s.user);
  const [selected, setSelected] = useState<ApiAction | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refreshBoard();
      if (!cancelled) {
        timer.current = setTimeout(tick, useApp.getState().boardError === undefined ? POLL_MS : POLL_BACKOFF_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [refreshBoard]);

  // 轮询后同步抽屉内容（服务端事实为准，不改选中 ID）
  const selectedId = selected?.id;
  const latest = useApp((s) => (selectedId === undefined ? undefined : s.actions.find((a) => a.id === selectedId)));
  const drawerAction = latest ?? selected;

  return (
    <>
      {boardError === undefined ? null : null /* 错误条在外壳顶栏呈现，保持看板区域干净 */}
      <Board onOpenDetail={setSelected} />
      {drawerAction !== undefined ? (
        <DetailDrawer
          action={drawerAction}
          userRole={user?.role}
          onClose={() => setSelected(undefined)}
          onMutated={refreshBoard}
        />
      ) : null}
    </>
  );
}
