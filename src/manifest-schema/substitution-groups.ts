/**
 * Known XSD substitution groups: abstract elements mapped to their concrete substitutions.
 * These are elements like VisualElementsChoice that users never type directly.
 */
export const SUBSTITUTION_GROUPS: Record<string, Array<{ name: string; namespace: string }>> = {
    'VisualElementsChoice': [
        { name: 'VisualElements', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
    ],
    'ApplicationExtensionChoice': [
        { name: 'Extension', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
    ],
    'CapabilityChoice': [
        { name: 'Capability', namespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' },
        { name: 'Capability', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
        { name: 'DeviceCapability', namespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' },
    ],
    'HoloContentChoice': [],
};
