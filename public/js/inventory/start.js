// Opens the mode in the address (Test case by default) once every tool file has loaded.
window.addEventListener('hashchange', () => showMode(location.hash.slice(1)));
showMode(location.hash.slice(1) || 'case');
loadCatalog();
