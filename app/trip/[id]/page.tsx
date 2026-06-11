import TripView from "@/components/TripView";

export default async function TripPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TripView tripId={id} />;
}
