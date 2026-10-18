/// <reference types="vite/client" />
import { UserRound } from "lucide-react";
import { memo, useMemo } from "react";
import { defaultAssistantAvatar, isAvatarDataUrl } from "../shared/avatars";
import "./avatars.css";

export const Avatar = memo(function Avatar({ role, source }: { role: "user" | "assistant"; source?: string | undefined }) {
  const custom = useMemo(() => source && isAvatarDataUrl(source) ? source : undefined, [source]);
  const image = custom || (role === "assistant" ? `${import.meta.env.BASE_URL}${defaultAssistantAvatar.slice(1)}` : undefined);
  const label = role === "user" ? "用户头像" : "智能体头像";
  return image ? <img className={`chat-avatar avatar-${role}`} src={image} alt={label} /> : <span className="chat-avatar avatar-user" role="img" aria-label={label}><UserRound size={17} aria-hidden="true" /></span>;
});
