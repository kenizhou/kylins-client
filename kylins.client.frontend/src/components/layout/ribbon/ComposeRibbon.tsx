import { useState, useRef, useEffect } from 'react';
import {
  ClockIcon,
  AttachmentIcon,
  LinkIcon,
  CopySlashIcon,
  ArrowUpIcon,
  MinusIcon,
  ArrowDownIcon,
  LockIcon,
  ShieldCheckIcon,
  CaretDownIcon,
  MailOpenIcon,
  MailIcon,
} from '../../icons';
import { useComposerStore } from '../../../stores/composerStore';
import type { Importance } from '../../../stores/composerStore';
import { useClassification } from '../../../features/classification/useClassification';
import { RibbonButton, RibbonGroup, RibbonToggle } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';

export function ComposeRibbon() {
  const {
    classificationId,
    isEncrypted,
    isSigned,
    importance,
    requestReadReceipt,
    requestDeliveryReceipt,
    deliverAt,
    preventCopy,
    setIsEncrypted,
    setIsSigned,
    setImportance,
    setRequestReadReceipt,
    setRequestDeliveryReceipt,
    setPreventCopy,
  } = useComposerStore();
  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  const requiresCrypto = currentLevel.id === 'confidential' || currentLevel.id === 'restricted';

  const scheduleActive = deliverAt != null;

  const [importanceOpen, setImportanceOpen] = useState(false);
  const importanceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!importanceOpen) return;
    function handleClick(e: MouseEvent) {
      if (!importanceRef.current?.contains(e.target as Node)) {
        setImportanceOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [importanceOpen]);

  const [trackingOpen, setTrackingOpen] = useState(false);
  const trackingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!trackingOpen) return;
    function handleClick(e: MouseEvent) {
      if (!trackingRef.current?.contains(e.target as Node)) {
        setTrackingOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [trackingOpen]);

  const importanceLabel = importance === 'high' ? 'High' : importance === 'low' ? 'Low' : 'Normal';
  const importanceOptions: Array<{ value: Importance; label: string; icon: React.ReactNode }> = [
    { value: 'high', label: 'High', icon: <ArrowUpIcon size={14} /> },
    { value: 'normal', label: 'Normal', icon: <MinusIcon size={14} /> },
    { value: 'low', label: 'Low', icon: <ArrowDownIcon size={14} /> },
  ];

  return (
    <RibbonShell>
      <RibbonGroup>
        <RibbonButton
          icon={<ClockIcon size={17} />}
          split
          title={
            scheduleActive ? new Date(deliverAt).toLocaleString() : 'Schedule / Delay delivery'
          }
          className={scheduleActive ? 'text-[var(--primary)]' : undefined}
          onClick={() => window.dispatchEvent(new Event('composer:schedule-requested'))}
        >
          {scheduleActive ? 'Scheduled' : 'Delay Delivery'}
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup>
        <div ref={importanceRef} className="relative flex items-center">
          <button
            type="button"
            onClick={() => setImportanceOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded px-2.5 h-8 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            title="Importance"
          >
            <span className="whitespace-nowrap">Importance: {importanceLabel}</span>
            <CaretDownIcon size={10} className="opacity-70" />
          </button>

          {importanceOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
              {importanceOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setImportance(option.value);
                    setImportanceOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    importance === option.value
                      ? 'bg-[var(--selected)] text-[var(--foreground)]'
                      : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
                  }`}
                >
                  <span className="text-[var(--muted-text)]">{option.icon}</span>
                  <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  {importance === option.value && <span className="text-[var(--primary)]">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </RibbonGroup>

      <RibbonGroup>
        <div ref={trackingRef} className="relative flex items-center">
          <button
            type="button"
            onClick={() => setTrackingOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded px-2.5 h-8 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            title="Tracking"
          >
            <span className="whitespace-nowrap">Tracking</span>
            {(requestReadReceipt || requestDeliveryReceipt) && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
            )}
            <CaretDownIcon size={10} className="opacity-70" />
          </button>

          {trackingOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
              <button
                type="button"
                onClick={() => setRequestReadReceipt(!requestReadReceipt)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  requestReadReceipt
                    ? 'bg-[var(--selected)] text-[var(--foreground)]'
                    : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
                }`}
              >
                <span className="text-[var(--muted-text)]">
                  <MailOpenIcon size={14} />
                </span>
                <span className="flex-1 whitespace-nowrap">Read Receipt</span>
                {requestReadReceipt && <span className="text-[var(--primary)]">✓</span>}
              </button>
              <button
                type="button"
                onClick={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  requestDeliveryReceipt
                    ? 'bg-[var(--selected)] text-[var(--foreground)]'
                    : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
                }`}
              >
                <span className="text-[var(--muted-text)]">
                  <MailIcon size={14} />
                </span>
                <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
                {requestDeliveryReceipt && <span className="text-[var(--primary)]">✓</span>}
              </button>
            </div>
          )}
        </div>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonToggle
          icon={<LockIcon size={14} />}
          label="Encrypt"
          checked={isEncrypted}
          disabled={requiresCrypto}
          onChange={setIsEncrypted}
        />
        <RibbonToggle
          icon={<ShieldCheckIcon size={14} />}
          label="Sign"
          checked={isSigned}
          disabled={requiresCrypto}
          onChange={setIsSigned}
        />
        <RibbonToggle
          icon={<CopySlashIcon size={14} />}
          label="Prevent Copy"
          title="Discourage forwarding/copying (best-effort)"
          checked={preventCopy}
          onChange={setPreventCopy}
        />
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton icon={<AttachmentIcon size={17} />}>Attach</RibbonButton>
        <RibbonButton
          icon={<LinkIcon size={17} />}
          onClick={() => window.dispatchEvent(new Event('composer:insert-link'))}
        >
          Link
        </RibbonButton>
      </RibbonGroup>
    </RibbonShell>
  );
}
