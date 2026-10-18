import { Avatar } from "../Avatar";

export function AgentProgress({ label, avatar }: { label: string; avatar?: string | undefined }) {
  return <div className="agent-progress" role="status" aria-label="智能体运行状态" aria-live="polite"><Avatar role="assistant" source={avatar} /><span>{label}</span><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></div>;
}
