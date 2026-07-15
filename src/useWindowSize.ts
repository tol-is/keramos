
import { useState, useEffect } from "react";

export function useWindowSize() {
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setSize({ w: window.innerWidth, h: window.innerHeight });
    const onResize = () =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return size;
}
