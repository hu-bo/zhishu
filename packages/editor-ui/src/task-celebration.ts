import { EDITOR_TASK_COMPLETED_EVENT } from "@zhishu/editor-core";

export function installTaskCelebration(shell: HTMLElement): () => void {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const bursts = new Map<HTMLElement, number>();
  const clear = () => {
    for (const [burst, timer] of bursts) {
      window.clearTimeout(timer);
      burst.remove();
    }
    bursts.clear();
  };
  const onComplete = (event: Event) => {
    if (preference.matches || !(event.target instanceof HTMLElement)) return;
    if (event.target.closest(".zhishu-ui-shell") !== shell) return;
    const rect = event.target.getBoundingClientRect();
    const burst = document.createElement("span");
    burst.className = "zhishu-task-celebration";
    burst.setAttribute("aria-hidden", "true");
    burst.style.left = `${rect.left + 10}px`;
    burst.style.top = `${rect.top + rect.height / 2}px`;
    for (let index = 0; index < 8; index++) {
      const particle = document.createElement("i");
      const angle = (index / 8) * Math.PI * 2;
      particle.style.setProperty("--zhishu-task-dx", `${Math.cos(angle) * 28}px`);
      particle.style.setProperty("--zhishu-task-dy", `${Math.sin(angle) * 24 - 12}px`);
      burst.append(particle);
    }
    shell.append(burst);
    bursts.set(
      burst,
      window.setTimeout(() => {
        burst.remove();
        bursts.delete(burst);
      }, 700),
    );
  };
  const onPreferenceChange = () => {
    if (preference.matches) clear();
  };
  shell.addEventListener(EDITOR_TASK_COMPLETED_EVENT, onComplete);
  preference.addEventListener("change", onPreferenceChange);
  return () => {
    shell.removeEventListener(EDITOR_TASK_COMPLETED_EVENT, onComplete);
    preference.removeEventListener("change", onPreferenceChange);
    clear();
  };
}
