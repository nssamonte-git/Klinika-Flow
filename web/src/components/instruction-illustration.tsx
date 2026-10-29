import { BedDouble, CalendarDays, GlassWater } from "lucide-react";
import { illustrations } from "@backend/domain/illustrations";
export default function InstructionIllustration({ illustrationId }: { illustrationId: string }) {
  const item = illustrations.find(item => item.id === illustrationId);
  if (!item) return null;
  const Icon = item.icon === "bed" ? BedDouble : item.icon === "water" ? GlassWater : CalendarDays;
  return <span className="instruction-illustration" role="img" aria-label={item.description}><Icon size={42} strokeWidth={1.6} aria-hidden="true" /><span>{item.title}</span></span>;
}
