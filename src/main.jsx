import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/kalam/latin-400.css';
import './vendor/charade/icons.css';
import './styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
