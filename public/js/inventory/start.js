// Opens the feature in the address (or the last one used) once every tool file has loaded.
// Masters used to live on this page as #masters: send those old links to the Masters module.
if (DESK.module !== 'masters' && location.hash === '#masters') location.replace('/masters');
else {
  Tabs.init(MODULE);
  loadCatalog();
}
