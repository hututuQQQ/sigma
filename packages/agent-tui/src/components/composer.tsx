export interface ComposerProps {
  input: string;
  running: boolean;
  approvalPending: boolean;
}

export function Composer(props: ComposerProps): string {
  const prompt = props.approvalPending ? "approval> " : props.running ? "sigma (running)> " : "sigma> ";
  return `${prompt}${props.input}`;
}
