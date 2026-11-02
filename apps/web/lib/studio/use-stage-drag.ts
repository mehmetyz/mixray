import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { clampToStage, type StagePoint } from "./area";

export type StageDrag = {
  start: StagePoint;
  end: StagePoint;
};

export type StageDragHandlers = {
  onChange: (drag: StageDrag | null) => void;
  onFinish: (drag: StageDrag, stage: DOMRect) => void;
};

/**
 * Draws across a stage with the pointer. The window hears the move and the release, so a drag ends
 * wherever the button comes up, even outside the stage, and stays inside the stage's edges.
 */
export function useStageDrag(handlers: StageDragHandlers): (event: ReactPointerEvent<HTMLElement>) => void {
  const latest = useRef(handlers);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => () => stopRef.current?.(), []);

  return (event) => {
    stopRef.current?.();
    const stage = event.currentTarget;
    const pointOf = (x: number, y: number): StagePoint => {
      const box = stage.getBoundingClientRect();
      return clampToStage({ x: x - box.left, y: y - box.top }, { width: box.width, height: box.height });
    };
    const start = pointOf(event.clientX, event.clientY);

    const onMove = (move: PointerEvent) => {
      latest.current.onChange({ start, end: pointOf(move.clientX, move.clientY) });
    };
    const onUp = (up: PointerEvent) => {
      stop();
      latest.current.onFinish({ start, end: pointOf(up.clientX, up.clientY) }, stage.getBoundingClientRect());
    };
    const onCancel = () => {
      stop();
      latest.current.onChange(null);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      stopRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    stopRef.current = stop;
    latest.current.onChange({ start, end: start });
  };
}
