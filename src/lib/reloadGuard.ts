// Whether reloading now would lose work (a trip being planned, a live drive). Kept apart from swUpdate.ts
// so that module can load after start-up.
let blocked = () => false;

export function setReloadBlocker(check: () => boolean): void {
  blocked = check;
}

export const reloadBlocked = (): boolean => blocked();
