declare module "brackets-viewer/dist/brackets-viewer.min.js";

interface Window {
  bracketsViewer?: {
    render: (data: unknown, config?: unknown) => Promise<void>;
  };
}
