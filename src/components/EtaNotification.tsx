interface EtaNotificationProps {
  routeShortName: string;
  stopName: string;
  etaSeconds: number;
  onDismiss: () => void;
}

export const EtaNotification: React.FC<EtaNotificationProps> = ({
  routeShortName, stopName, etaSeconds, onDismiss,
}) => {
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = etaSeconds % 60;
  const etaText = minutes > 0
    ? `${minutes} min ${seconds}s`
    : `${seconds}s`;

  return (
    <div className="fixed top-4 left-4 right-4 z-50 flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-900/90 border border-amber-200 dark:border-amber-700 p-3 shadow-lg animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-800 flex items-center justify-center text-amber-700 dark:text-amber-200 font-bold text-xs">
        🚌
      </div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-amber-800 dark:text-amber-100">
          Bus {routeShortName} approaching
        </div>
        <div className="text-xs text-amber-600 dark:text-amber-300 mt-0.5">
          {stopName} — arriving in {etaText}
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 w-7 h-7 rounded-full bg-white dark:bg-white/10 hover:bg-amber-200 dark:hover:bg-amber-800 flex items-center justify-center text-amber-600 dark:text-amber-300 transition-colors"
        aria-label="Dismiss"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
