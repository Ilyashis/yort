/** Клавиатурное событие пришло из поля ввода — горячие клавиши сцены его не трогают. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}
