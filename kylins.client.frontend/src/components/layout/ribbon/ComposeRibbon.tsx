import { SendIcon, ClockIcon, AttachmentIcon, LinkIcon } from '../../icons';
import { ArrowBendUpRight, Lock, ShieldCheck, Warning } from '@phosphor-icons/react';
import { useComposerStore } from '../../../stores/composerStore';
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
    deliverAt,
    preventCopy,
    setIsEncrypted,
    setIsSigned,
    setImportance,
    setRequestReadReceipt,
    setPreventCopy,
  } = useComposerStore();
  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  const requiresCrypto = currentLevel.id === 'confidential' || currentLevel.id === 'restricted';

  const scheduleActive = deliverAt != null;

  return (
    <RibbonShell>
      <RibbonGroup>
        <RibbonButton
          primary
          icon={<SendIcon size={17} />}
          onClick={() => window.dispatchEvent(new Event('composer:send-requested'))}
        >
          Send
        </RibbonButton>
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
        <RibbonToggle
          icon={<ArrowBendUpRight size={14} />}
          label="High Importance"
          title="High priority"
          checked={importance === 'high'}
          onChange={(checked) => setImportance(checked ? 'high' : 'normal')}
        />
        <RibbonToggle
          icon={<Warning size={14} />}
          label="Low Importance"
          title="Low priority"
          checked={importance === 'low'}
          onChange={(checked) => setImportance(checked ? 'low' : 'normal')}
        />
        <RibbonToggle
          icon={<AttachmentIcon size={14} />}
          label="Read Receipt"
          title="Request a read receipt"
          checked={requestReadReceipt}
          onChange={setRequestReadReceipt}
        />
      </RibbonGroup>

      <RibbonGroup>
        <RibbonToggle
          icon={<Lock size={14} />}
          label="Encrypt"
          checked={isEncrypted}
          disabled={requiresCrypto}
          onChange={setIsEncrypted}
        />
        <RibbonToggle
          icon={<ShieldCheck size={14} />}
          label="Sign"
          checked={isSigned}
          disabled={requiresCrypto}
          onChange={setIsSigned}
        />
        <RibbonToggle
          icon={<Warning size={14} />}
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
