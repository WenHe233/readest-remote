/** Build capability, independent of the per-device cloud sync preference. */
export const isReadestCloudAvailable = () =>
  process.env['NEXT_PUBLIC_READEST_CLOUD_ENABLED'] !== 'false';
