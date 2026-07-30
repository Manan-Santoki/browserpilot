import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";

export type LivePreviewHandle = {
  push(base64: string): void;
};

type Layer = {
  generation: number;
  uri: string | null;
};

const EMPTY_LAYER: Layer = { generation: 0, uri: null };

/**
 * A stable surface for the browser stream.
 *
 * Replacing the source of the one visible Image makes React Native clear its
 * texture while the next JPEG is decoded, which reads as a flash at stream
 * frame rates. These two layers alternate: the old frame remains visible while
 * the newest frame decodes behind it, then the layers swap atomically.
 */
export const LivePreview = forwardRef<LivePreviewHandle, { placeholder: React.ReactNode }>(
  function LivePreview({ placeholder }, ref) {
    const [layers, setLayers] = useState<[Layer, Layer]>([EMPTY_LAYER, EMPTY_LAYER]);
    const [visible, setVisible] = useState<0 | 1 | null>(null);

    const visibleRef = useRef<0 | 1 | null>(null);
    const loadingRef = useRef<{ index: 0 | 1; generation: number } | null>(null);
    const queuedRef = useRef<string | null>(null);
    const generationRef = useRef(0);

    const beginLoad = useCallback((uri: string) => {
      const index: 0 | 1 = visibleRef.current === 0 ? 1 : 0;
      const generation = ++generationRef.current;
      loadingRef.current = { index, generation };
      setLayers((current) => {
        const next: [Layer, Layer] = [...current];
        next[index] = { generation, uri };
        return next;
      });
    }, []);

    const loadQueued = useCallback(() => {
      if (loadingRef.current) return;
      const next = queuedRef.current;
      queuedRef.current = null;
      if (next) beginLoad(next);
    }, [beginLoad]);

    const push = useCallback(
      (base64: string) => {
        queuedRef.current = `data:image/jpeg;base64,${base64}`;
        loadQueued();
      },
      [loadQueued],
    );

    useImperativeHandle(ref, () => ({ push }), [push]);

    const finishLoad = useCallback(
      (index: 0 | 1, generation: number, succeeded: boolean) => {
        const loading = loadingRef.current;
        if (!loading || loading.index !== index || loading.generation !== generation) return;

        loadingRef.current = null;
        if (succeeded) {
          visibleRef.current = index;
          setVisible(index);
        }
        loadQueued();
      },
      [loadQueued],
    );

    return (
      <View style={styles.host}>
        {layers.map((layer, index) =>
          layer.uri ? (
            <Image
              key={`${index}:${layer.generation}`}
              source={{ uri: layer.uri }}
              style={[styles.frame, visible === index ? styles.visible : styles.hidden]}
              resizeMode="contain"
              onLoad={() => finishLoad(index as 0 | 1, layer.generation, true)}
              onError={() => finishLoad(index as 0 | 1, layer.generation, false)}
            />
          ) : null,
        )}
        {visible === null ? <View style={styles.placeholder}>{placeholder}</View> : null}
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
  visible: { opacity: 1 },
  hidden: { opacity: 0 },
  placeholder: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
