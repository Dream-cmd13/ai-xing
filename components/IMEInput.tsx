
import React, { useState, useEffect, useRef } from 'react';

interface IMEInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onValueChange?: (value: string) => void;
}

export const IMEInput: React.FC<IMEInputProps> = ({ 
  value, 
  onChange, 
  onValueChange, 
  onCompositionStart, 
  onCompositionEnd, 
  ...props 
}) => {
  const [localValue, setLocalValue] = useState<string>(String(value || ''));
  const isComposing = useRef(false);

  // Sync with external value when not composing
  useEffect(() => {
    if (!isComposing.current) {
      setLocalValue(String(value || ''));
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    // If not composing, trigger external updates immediately
    if (!isComposing.current) {
      if (onChange) onChange(e);
      if (onValueChange) onValueChange(newValue);
    }
  };

  const handleCompositionStart = (e: React.CompositionEvent<HTMLInputElement>) => {
    isComposing.current = true;
    if (onCompositionStart) onCompositionStart(e);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    isComposing.current = false;
    const finalValue = e.currentTarget.value;
    setLocalValue(finalValue);
    
    if (onCompositionEnd) onCompositionEnd(e);
    
    // Trigger external updates with the final composed value
    // Create a synthetic-like event for onChange compatibility
    if (onChange) {
      const syntheticEvent = {
        ...e,
        target: e.currentTarget,
        currentTarget: e.currentTarget,
      } as unknown as React.ChangeEvent<HTMLInputElement>;
      onChange(syntheticEvent);
    }
    if (onValueChange) onValueChange(finalValue);
  };

  return (
    <input
      {...props}
      value={localValue}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  );
};

interface IMETextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  onValueChange?: (value: string) => void;
}

export const IMETextarea: React.FC<IMETextareaProps> = ({ 
  value, 
  onChange, 
  onValueChange, 
  onCompositionStart, 
  onCompositionEnd, 
  ...props 
}) => {
  const [localValue, setLocalValue] = useState<string>(String(value || ''));
  const isComposing = useRef(false);

  useEffect(() => {
    if (!isComposing.current) {
      setLocalValue(String(value || ''));
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    if (!isComposing.current) {
      if (onChange) onChange(e);
      if (onValueChange) onValueChange(newValue);
    }
  };

  const handleCompositionStart = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposing.current = true;
    if (onCompositionStart) onCompositionStart(e);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposing.current = false;
    const finalValue = e.currentTarget.value;
    setLocalValue(finalValue);
    
    if (onCompositionEnd) onCompositionEnd(e);
    
    if (onChange) {
      const syntheticEvent = {
        ...e,
        target: e.currentTarget,
        currentTarget: e.currentTarget,
      } as unknown as React.ChangeEvent<HTMLTextAreaElement>;
      onChange(syntheticEvent);
    }
    if (onValueChange) onValueChange(finalValue);
  };

  return (
    <textarea
      {...props}
      value={localValue}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  );
};
