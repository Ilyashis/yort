import { useEffect, useRef } from 'react';

/**
 * Всплывающая панель закрывается кликом мимо неё (кроме её кнопки) и клавишей Esc. Esc ловим раньше
 * редактора (на этапе погружения) и дальше не пускаем: закрыли панель — выделение и инструмент остаются.
 */
export function useDismiss(onClose: () => void, buttonSelector: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest?.(buttonSelector)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, buttonSelector]);
  return ref;
}
