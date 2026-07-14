import { useCallback, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import { useUiStore } from '../../state/uiStore';
import { FileExplorer } from '../explorer/FileExplorer';

const MIN_WIDTH = 180;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 260;

export function SideBar(): JSX.Element | null {
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const delta = e.clientX - startX.current;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
    setWidth(next);
  }, []);

  const onMouseUp = useCallback(() => {
    setDragging(false);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }, [onMouseMove]);

  const onHandleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startWidth.current = width;
      setDragging(true);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [width, onMouseMove, onMouseUp],
  );

  if (!sidebarVisible) return null;

  return (
    <div className="sidebar" style={{ width }}>
      <FileExplorer />
      <div
        className={dragging ? 'sidebar__resize-handle sidebar__resize-handle--active' : 'sidebar__resize-handle'}
        onMouseDown={onHandleMouseDown}
      />
    </div>
  );
}
