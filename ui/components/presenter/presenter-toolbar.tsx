"use client";

import { useState, useCallback } from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Hand,
  Users,
  List,
  PhoneOff,
  MoreHorizontal,
  Copy,
  Check,
} from "lucide-react";

interface PresenterToolbarProps {
  isAudioMuted: boolean;
  isVideoMuted: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onRaiseHand: () => void;
  onToggleParticipants: () => void;
  onToggleChapters: () => void;
  onLeave: () => void;
  onInvite?: () => Promise<void>;
  participantCount: number;
  showParticipants: boolean;
  showChapters: boolean;
  /** Whether the raise-hand action is available (only during PLAYING phase) */
  canRaiseHand: boolean;
}

/**
 * Microsoft Teams–inspired floating bottom toolbar for the presenter page.
 * Full-featured on desktop, collapses to essential controls + overflow menu on mobile.
 */
export function PresenterToolbar({
  isAudioMuted,
  isVideoMuted,
  onToggleAudio,
  onToggleVideo,
  onRaiseHand,
  onToggleParticipants,
  onToggleChapters,
  onLeave,
  onInvite,
  participantCount,
  showParticipants,
  showChapters,
  canRaiseHand,
}: PresenterToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const handleInvite = useCallback(async () => {
    if (!onInvite) return;
    await onInvite();
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2500);
    setMoreOpen(false);
  }, [onInvite]);

  return (
    <div
      className="shrink-0 flex items-center justify-center bg-zinc-950/95 px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="relative flex items-center gap-1 rounded-2xl border border-white/10 bg-zinc-900/95 px-2 py-2 shadow-2xl backdrop-blur-xl sm:gap-2 sm:px-4">
        {/* ── Mic ── */}
        <ToolbarButton
          icon={isAudioMuted ? MicOff : Mic}
          label={isAudioMuted ? "Unmute" : "Mute"}
          active={!isAudioMuted}
          danger={isAudioMuted}
          onClick={onToggleAudio}
        />

        {/* ── Camera ── */}
        <ToolbarButton
          icon={isVideoMuted ? VideoOff : Video}
          label={isVideoMuted ? "Turn on camera" : "Turn off camera"}
          active={!isVideoMuted}
          danger={isVideoMuted}
          onClick={onToggleVideo}
        />

        <Divider />

        {/* ── Raise Hand (desktop always visible, mobile in overflow) ── */}
        <div className="hidden sm:block">
          <ToolbarButton
            icon={Hand}
            label="Raise Hand"
            onClick={onRaiseHand}
            disabled={!canRaiseHand}
          />
        </div>

        {/* ── Chapters ── */}
        <div className="hidden md:block">
          <ToolbarButton
            icon={List}
            label="Chapters"
            active={showChapters}
            onClick={onToggleChapters}
          />
        </div>

        {/* ── Participants ── */}
        <ToolbarButton
          icon={Users}
          label={`${participantCount}`}
          active={showParticipants}
          onClick={onToggleParticipants}
          badge={participantCount > 1 ? participantCount : undefined}
        />

        <Divider />

        {/* ── More (mobile overflow) ── */}
        <div className="relative sm:hidden">
          <ToolbarButton
            icon={MoreHorizontal}
            label="More"
            onClick={() => setMoreOpen((v) => !v)}
            active={moreOpen}
          />
          {moreOpen && (
            <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
              <OverflowItem
                icon={Hand}
                label="Raise Hand"
                onClick={() => { onRaiseHand(); setMoreOpen(false); }}
                disabled={!canRaiseHand}
              />
              <OverflowItem
                icon={List}
                label="Chapters"
                onClick={() => { onToggleChapters(); setMoreOpen(false); }}
              />
            </div>
          )}
        </div>

        {/* ── Invite (host only) ── */}
        {onInvite && <button
          onClick={handleInvite}
          title="Copy invite link"
          className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs font-medium transition sm:px-3 ${
            inviteCopied
              ? "border-green-500/40 bg-green-500/10 text-green-400"
              : "border-white/20 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
          }`}
        >
          {inviteCopied ? (
            <Check className="h-4 w-4 shrink-0" />
          ) : (
            <Copy className="h-4 w-4 shrink-0" />
          )}
          <span>{inviteCopied ? "Copied!" : "Invite"}</span>
        </button>}

        <Divider />

        {/* ── Leave ── */}
        <button
          onClick={onLeave}
          title="Leave presentation"
          className="flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-700 sm:px-4 sm:text-sm"
        >
          <PhoneOff className="h-4 w-4" />
          <span className="hidden sm:inline">Leave</span>
        </button>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function Divider() {
  return <div className="mx-0.5 h-8 w-px bg-white/10 sm:mx-1" />;
}

type LucideIcon = React.ComponentType<{ className?: string }>;

function ToolbarButton({
  icon: Icon,
  label,
  active,
  danger,
  disabled,
  onClick,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition sm:h-11 sm:w-11 ${
        danger
          ? "bg-red-600/20 text-red-400 hover:bg-red-600/30"
          : active
            ? "bg-white/10 text-white"
            : "text-white/60 hover:bg-white/10 hover:text-white"
      } disabled:pointer-events-none disabled:opacity-30`}
    >
      <Icon className="h-5 w-5" />
      {badge !== undefined && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

function OverflowItem({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/80 transition hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
