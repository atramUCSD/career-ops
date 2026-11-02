// This boundary wraps the layout's children, which render inside the camera
// world, not the wizard itself. A visible fallback here would cover the stages
// on every hop. It still earns its place: with a loading state the router
// commits the new segment at once, so the camera takes off without waiting for
// the server round trip.
export default function Loading() {
  return null;
}
