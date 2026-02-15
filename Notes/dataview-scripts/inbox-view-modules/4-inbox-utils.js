/**
 * Выпадающие меню Inbox: одна открытая запись (openMenu), closeDropdownMenu, setOpenMenu, getOpenMenu.
 */
let openMenu = null;

function closeDropdownMenu() {
    if (openMenu) {
        openMenu.remove();
        openMenu = null;
    }
}

function setOpenMenu(menuElement) {
    openMenu = menuElement;
}

function getOpenMenu() {
    return openMenu;
}

return {
    closeDropdownMenu,
    setOpenMenu,
    getOpenMenu
};