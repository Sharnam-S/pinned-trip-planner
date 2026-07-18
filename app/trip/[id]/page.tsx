import TripView from "@/components/TripView";

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { id } = await params;
  const { embed } = await searchParams;
  return <TripView tripId={id} embed={embed === "1"} />;
}
