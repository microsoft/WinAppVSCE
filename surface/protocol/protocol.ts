/**
 * Surface v1 wire shapes, not a transport or renderer implementation.
 * See README.md for receiver defaults, asymmetries, and lifecycle limitations.
 */
export const protocolVersion = 1;
export const knownCapabilities = ['frame-stream', 'native-hwnd'] as const;
export type KnownCapability = typeof knownCapabilities[number];
export type Capability = string; // Unknown advertised capabilities are additive.
export type Theme = 'Light' | 'Dark' | 'Default';

interface Size {
    width?: number;
    height?: number;
    scale?: number;
}

export interface Hello {
    type: 'Hello';
    client?: string;
    caps?: Capability[];
    protocol?: number;
}
export interface LoadXaml extends Size { type: 'LoadXaml'; xaml: string }
export interface UpdateXaml { type: 'UpdateXaml'; xaml: string }
export interface Resize extends Size { type: 'Resize' }
export interface EnterNative extends Size { type: 'EnterNative'; xaml: string }
export interface ExitNative { type: 'ExitNative' }
export interface Ping { type: 'Ping' }
export interface SetMode { type: 'SetMode'; design?: boolean }
export interface SelectByPath { type: 'SelectByPath'; path?: string | null }
/** Test-only command; coordinates are artboard/host DIPs. */
export interface PickAt { type: 'PickAt'; x: number; y: number }
export interface SetProperty {
    type: 'SetProperty';
    id: number;
    name: string;
    value?: string | null;
}
/** Compatibility no-op. Apply themes by restarting the process, not this message. */
export interface SetTheme { type: 'SetTheme'; theme?: Theme }
export interface SetCanvasSize { type: 'SetCanvasSize'; width?: number; height?: number }

export type ClientMessage = Hello | LoadXaml | UpdateXaml | Resize | EnterNative
    | ExitNative | Ping | SetMode | SelectByPath | PickAt | SetProperty | SetTheme | SetCanvasSize;

export interface Ready { type: 'Ready'; protocol: number; caps: Capability[]; wasdk: string }
export interface Frame {
    type: 'Frame';
    format: 'png';
    width: number;
    height: number;
    dipWidth: number;
    dipHeight: number;
    data: string;
}
export type KnownErrorPhase = 'parse' | 'activation' | 'render' | 'nonpage';
export interface ErrorMessage {
    type: 'Error';
    phase: string; // Display unknown phases rather than treating them as malformed.
    message: string;
    line?: number | null;
    column?: number | null;
    notDesignable?: boolean;
}
export interface Hwnd {
    type: 'Hwnd';
    /** JSON signed Int64; JS consumers must reject values outside the safe integer range. */
    hwnd: number;
    dipWidth: number;
    dipHeight: number;
    pixelWidth: number;
    pixelHeight: number;
    scale: number;
}
export interface NativeExited { type: 'NativeExited' }
export interface Pong { type: 'Pong' }
export interface Selected {
    type: 'Selected';
    id: number;
    elementType: string;
    name?: string | null;
    path?: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface PropItem {
    name: string;
    category: string;
    type: string;
    value: string;
    readOnly: boolean;
    options?: string[] | null;
}
export interface ElementProps { type: 'ElementProps'; id: number; props: PropItem[] }
export interface ContentProps { type: 'ContentProps'; map: Record<string, string> }
export type ServerMessage = Ready | Frame | ErrorMessage | Hwnd | NativeExited | Pong
    | Selected | ElementProps | ContentProps;
export type WireMessage = ClientMessage | ServerMessage;
