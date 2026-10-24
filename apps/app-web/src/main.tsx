import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@/styles/globals.css';
import '@zhishu/editor-ui/styles.css';
import { installOfflineWorker } from '@/features/offline/install-worker';
import { initializeTheme } from '@/lib/theme';

initializeTheme();
installOfflineWorker();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Application root is missing');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
