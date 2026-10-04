export function installOfflineWorker() {
  if (
    (import.meta.env.PROD || import.meta.env.VITE_ENABLE_OFFLINE === 'true') &&
    'serviceWorker' in navigator
  ) {
    const reportFailure = () => window.dispatchEvent(new Event('zhishu-offline-worker-error'));
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}service-worker.js`)
      .then((registration) => {
        const observeInstallation = () => {
          const worker = registration.installing;
          if (!worker) return;
          const onStateChange = () => {
            if (worker.state === 'redundant') reportFailure();
            if (worker.state === 'redundant' || worker.state === 'activated')
              worker.removeEventListener('statechange', onStateChange);
          };
          worker.addEventListener('statechange', onStateChange);
          onStateChange();
        };
        registration.addEventListener('updatefound', observeInstallation);
        observeInstallation();
      })
      .catch(reportFailure);
  }
}
