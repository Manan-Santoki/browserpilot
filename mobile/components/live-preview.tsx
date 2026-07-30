import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

export type LivePreviewHandle = {
  push(base64: string): void;
};

/**
 * A stable surface for the browser stream.
 *
 * React Native's two overlapping Image views are unstable on some Android
 * compositors: even after the stream stops, the GPU can alternate the retained
 * textures. Expo Image keeps the currently displayed drawable in one native
 * view while the next JPEG decodes, so there is no second texture to flash
 * through. Only one decode runs at a time and newer frames replace the queued
 * one — a delayed preview should skip history, not play it back.
 */
export const LivePreview = forwardRef<LivePreviewHandle, { placeholder: React.ReactNode }>(
  function LivePreview({ placeholder }, ref) {
    const [uri, setUri] = useState<string | null>(null);
    const [displayed, setDisplayed] = useState(false);
    const loadingRef = useRef(false);
    const currentRef = useRef<string | null>(null);
    const queuedRef = useRef<string | null>(null);

    const beginLoad = useCallback((uri: string) => {
      currentRef.current = uri;
      loadingRef.current = true;
      setUri(uri);
    }, []);

    const push = useCallback(
      (base64: string) => {
        const next = `data:image/jpeg;base64,${base64}`;
        if (next === currentRef.current || next === queuedRef.current) return;

        if (loadingRef.current) {
          queuedRef.current = next;
          return;
        }
        beginLoad(next);
      },
      [beginLoad],
    );

    useImperativeHandle(ref, () => ({ push }), [push]);

    const finishLoad = useCallback(
      (succeeded: boolean) => {
        if (!loadingRef.current) return;
        loadingRef.current = false;
        if (succeeded) {
          setDisplayed(true);
        } else {
          // Let a later copy of the same frame retry after a transient decode
          // failure instead of treating the broken source as current forever.
          currentRef.current = null;
        }

        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) beginLoad(next);
      },
      [beginLoad],
    );

    return (
      <View style={styles.host}>
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.frame}
            contentFit="contain"
            cachePolicy="none"
            transition={60}
            onDisplay={() => finishLoad(true)}
            onError={() => finishLoad(false)}
          />
        ) : null}
        {!displayed ? <View style={styles.placeholder}>{placeholder}</View> : null}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  host: { flex: 1 },
  frame: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  },
  placeholder: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
