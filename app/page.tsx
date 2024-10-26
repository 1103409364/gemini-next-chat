'use client'
import dynamic from 'next/dynamic'
import { useRef, useState, useMemo, KeyboardEvent, useEffect, useCallback } from 'react'
import type { FunctionCall } from '@google/generative-ai'
import { EdgeSpeech, getRecordMineType } from '@xiangfa/polly'
import SiriWave from 'siriwave'
import {
  MessageCircleHeart,
  AudioLines,
  Mic,
  MessageSquareText,
  Settings,
  Pause,
  SendHorizontal,
  Github,
  Blocks,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ThemeToggle from '@/components/ThemeToggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import SystemInstruction from '@/components/SystemInstruction'
import AttachmentArea from '@/components/AttachmentArea'
import Button from '@/components/Button'
import { useMessageStore } from '@/store/chat'
import { useAttachmentStore } from '@/store/attachment'
import { useSettingStore } from '@/store/setting'
import { usePluginStore } from '@/store/plugin'
import chat, { type RequestProps } from '@/utils/chat'
import { summarizePrompt, getVoiceModelPrompt, getSummaryPrompt, getTalkAudioPrompt } from '@/utils/prompt'
import { AudioRecorder } from '@/utils/Recorder'
import AudioStream from '@/utils/AudioStream'
import PromiseQueue from '@/utils/PromiseQueue'
import textStream, { streamToText } from '@/utils/textStream'
import { encodeToken } from '@/utils/signature'
import type { FileManagerOptions } from '@/utils/FileManager'
import { fileUpload, imageUpload } from '@/utils/upload'
import { findOperationById } from '@/utils/plugin'
import { formatTime, readFileAsDataURL } from '@/utils/common'
import { cn } from '@/utils'
import { OldVisionModel, OldTextModel } from '@/constant/model'
import mimeType from '@/constant/attachment'
import { customAlphabet } from 'nanoid'
import { isFunction, findIndex, isUndefined, entries, isEmpty } from 'lodash-es'
import { type OpenAPIV3_1 } from 'openapi-types'

interface AnswerParams {
  messages: Message[]
  model: string
  onResponse: (readableStream: ReadableStream) => void
  onFunctionCall?: (functionCalls: FunctionCall[]) => void
  onError?: (error: string, code?: number) => void
}

const BUILD_MODE = process.env.NEXT_PUBLIC_BUILD_MODE as string
const TEXTAREA_DEFAULT_HEIGHT = 30
const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 8)

const MessageItem = dynamic(() => import('@/components/MessageItem'))
const ErrorMessageItem = dynamic(() => import('@/components/ErrorMessageItem'))
const AssistantRecommend = dynamic(() => import('@/components/AssistantRecommend'))
const Setting = dynamic(() => import('@/components/Setting'))
const FileUploader = dynamic(() => import('@/components/FileUploader'))
const PluginStore = dynamic(() => import('@/components/PluginStore'))

export default function Home() {
  const { t } = useTranslation()
  const siriWaveRef = useRef<HTMLDivElement>(null)
  const scrollAreaBottomRef = useRef<HTMLDivElement>(null)
  const audioStreamRef = useRef<AudioStream>()
  const edgeSpeechRef = useRef<EdgeSpeech>()
  const audioRecordRef = useRef<AudioRecorder>()
  const speechQueue = useRef<PromiseQueue>()
  const messagesRef = useRef(useMessageStore.getState().messages)
  const messages = useMessageStore((state) => state.messages)
  const systemInstruction = useMessageStore((state) => state.systemInstruction)
  const files = useAttachmentStore((state) => state.files)
  const model = useSettingStore((state) => state.model)
  const autoStopRecord = useSettingStore((state) => state.autoStopRecord)
  const talkMode = useSettingStore((state) => state.talkMode)
  const [textareaHeight, setTextareaHeight] = useState<number>(TEXTAREA_DEFAULT_HEIGHT)
  const [siriWave, setSiriWave] = useState<SiriWave>()
  const [content, setContent] = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [subtitle, setSubtitle] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [recordTime, setRecordTime] = useState<number>(0)
  const [settingOpen, setSetingOpen] = useState<boolean>(false)
  const [pluginStoreOpen, setPluginStoreOpen] = useState<boolean>(false)
  const [speechSilence, setSpeechSilence] = useState<boolean>(false)
  const [isRecording, setIsRecording] = useState<boolean>(false)
  const [status, setStatus] = useState<'thinkng' | 'silence' | 'talking'>('silence')
  const statusText = useMemo(() => {
    switch (status) {
      case 'silence':
      case 'talking':
        return ''
      case 'thinkng':
      default:
        return t('status.thinking')
    }
  }, [status, t])
  const isOldVisionModel = useMemo(() => {
    return OldVisionModel.includes(model)
  }, [model])
  const supportAttachment = useMemo(() => {
    return !OldTextModel.includes(model)
  }, [model])
  const supportSpeechRecognition = useMemo(() => {
    return !OldTextModel.includes(model) && !OldVisionModel.includes(model)
  }, [model])
  const isUploading = useMemo(() => {
    for (const file of files) {
      if (file.status === 'PROCESSING') return true
    }
    return false
  }, [files])

  const speech = useCallback(
    (content: string) => {
      if (content.length === 0) return
      speechQueue.current?.enqueue(
        () =>
          new Promise(async (resolve, reject) => {
            if (speechSilence) reject(false)
            const { ttsVoice } = useSettingStore.getState()
            const voice = await edgeSpeechRef.current?.create({
              input: content,
              options: { voice: ttsVoice },
            })
            if (voice) {
              const audio = await voice.arrayBuffer()
              setStatus('talking')
              const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
              siriWave?.setSpeed(isSafari ? 0.1 : 0.05)
              siriWave?.setAmplitude(2)
              audioStreamRef.current?.play({
                audioData: audio,
                text: content,
                onStart: (text) => {
                  setSubtitle(text)
                },
                onFinished: () => {
                  setStatus('silence')
                  siriWave?.setSpeed(0.04)
                  siriWave?.setAmplitude(0.1)
                },
              })
              resolve(true)
            }
          }),
      )
    },
    [siriWave, speechSilence],
  )

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => scrollAreaBottomRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }, [])

  const fetchAnswer = useCallback(async ({ messages, model, onResponse, onFunctionCall, onError }: AnswerParams) => {
    const { apiKey, apiProxy, password, topP, topK, temperature, maxOutputTokens, safety } = useSettingStore.getState()
    const { tools } = usePluginStore.getState()
    const generationConfig: RequestProps['generationConfig'] = { topP, topK, temperature, maxOutputTokens }
    setErrorMessage('')
    const config: RequestProps = {
      messages,
      apiKey,
      model,
      generationConfig,
      safety,
    }
    if (systemInstruction) config.systemInstruction = systemInstruction
    if (tools.length > 0) config.tools = [{ functionDeclarations: tools }]
    if (apiKey !== '') {
      if (apiProxy) config.baseUrl = apiProxy
    } else {
      config.apiKey = encodeToken(password)
      config.baseUrl = '/api/google'
    }
    try {
      const stream = await chat(config)
      const readableStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          for await (const chunk of stream) {
            const calls = chunk.functionCalls()
            if (calls) {
              if (isFunction(onFunctionCall)) onFunctionCall(calls)
            } else {
              const text = chunk.text()
              const encoded = encoder.encode(text)
              controller.enqueue(encoded)
            }
          }
          controller.close()
        },
      })
      onResponse(readableStream)
    } catch (error) {
      if (error instanceof Error && isFunction(onError)) {
        onError(error.message)
      }
    }
  }, [systemInstruction])

  const summarize = useCallback(
    async (messages: Message[]) => {
      const { summary, summarize: summarizeChat } = useMessageStore.getState()
      const { ids, prompt } = summarizePrompt(messages, summary.ids, summary.content)
      await fetchAnswer({
        messages: [{ id: 'summary', role: 'user', parts: [{ text: prompt }] }],
        model: 'gemini-pro',
        onResponse: async (readableStream) => {
          const text = await streamToText(readableStream)
          summarizeChat(ids, text.trim())
        },
      })
    },
    [fetchAnswer],
  )

  const handleError = useCallback(async (message: string, code?: number) => {
    const messages = [...messagesRef.current]
    const lastMessage = messages.pop()
    if (lastMessage?.role === 'model') {
      const { revoke } = useMessageStore.getState()
      revoke(lastMessage.id)
      setStatus('silence')
      setErrorMessage(`${code ?? '400'}: ${message}`)
    }
  }, [])

  const handleResponse = useCallback(
    async (data: ReadableStream) => {
      const { lang, talkMode, maxHistoryLength } = useSettingStore.getState()
      const { summary, add: addMessage } = useMessageStore.getState()
      speechQueue.current = new PromiseQueue()
      setSpeechSilence(false)
      let text = ''
      await textStream({
        readable: data,
        locale: lang,
        onMessage: (content) => {
          text += content
          setMessage(text)
          scrollToBottom()
        },
        onStatement: (statement) => {
          if (talkMode === 'voice') {
            // Remove list symbols and adjust layout
            const audioText = statement.replaceAll('*', '').replaceAll('\n\n', '\n')
            speech(audioText)
          }
        },
        onFinish: async () => {
          if (talkMode === 'voice') {
            setStatus('silence')
          }
          addMessage({
            id: nanoid(),
            role: 'model',
            parts: [{ text }],
          })
          setMessage('')
          scrollToBottom()
          if (maxHistoryLength > 0) {
            const textMessages: Message[] = []
            for (const item of messagesRef.current) {
              for (const part of item.parts) {
                if (part.text) textMessages.push(item)
              }
            }
            const messageList = textMessages.filter((item) => !summary.ids.includes(item.id))
            if (messageList.length > maxHistoryLength) {
              await summarize(textMessages)
            }
          }
        },
      })
    },
    [scrollToBottom, speech, summarize],
  )

  const handleFunctionCall = useCallback(
    async (functionCalls: FunctionCall[]) => {
      const { model } = useSettingStore.getState()
      const { add: addMessage } = useMessageStore.getState()
      const { installed } = usePluginStore.getState()
      for (const call of functionCalls) {
        const newModelMessage: Message = { id: nanoid(), role: 'model', parts: [{ text: '' }] }
        const functionCallMessage = {
          id: nanoid(),
          role: 'model',
          parts: [
            {
              functionCall: call,
            },
          ],
        }
        addMessage(functionCallMessage)
        const pluginId = call.name.split('_')[0]
        const pluginManifest = installed[pluginId]
        let baseUrl = ''
        if (pluginManifest.openapi.servers) {
          baseUrl = pluginManifest.openapi.servers[0].url
        }
        const operation = findOperationById(pluginManifest.openapi, call.name.substring(1 + pluginId.length))
        if (!operation) return handleError('FunctionCall execution failed!')
        const { password } = useSettingStore.getState()
        const token = encodeToken(password)
        const payload: GatewayPayload = {
          baseUrl: `${baseUrl}${operation.path}`,
          method: operation.method as GatewayPayload['method'],
        }
        // let body: GatewayPayload['body'] = {}
        let formData: GatewayPayload['formData'] = {}
        let headers: GatewayPayload['headers'] = {}
        let path: GatewayPayload['path'] = {}
        let query: GatewayPayload['query'] = {}
        let cookie: GatewayPayload['cookie'] = {}
        for (const [name, value] of entries(call.args)) {
          const parameters = operation.parameters as OpenAPIV3_1.ParameterObject[]
          parameters?.forEach((parameter) => {
            if (parameter.name === name) {
              if (parameter.in === 'query') {
                query[name] = value
              } else if (parameter.in === 'path') {
                path[name] = value
              } else if (parameter.in === 'formData') {
                formData[name] = value
              } else if (parameter.in === 'headers') {
                headers[name] = value
              } else if (parameter.in === 'cookie') {
                cookie[name] = value
              }
            }
          })
        }
        // if (!isEmpty(body)) payload.body = body
        if (!isEmpty(formData)) payload.formData = formData
        if (!isEmpty(headers)) payload.headers = headers
        if (!isEmpty(path)) payload.path = path
        if (!isEmpty(query)) payload.query = query
        if (!isEmpty(cookie)) payload.cookie = cookie
        try {
          const apiResponse = await fetch(`/api/gateway?token=${token}`, {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          const functionResponseMessage = {
            id: nanoid(),
            role: 'function',
            parts: [
              {
                functionResponse: {
                  name: call.name,
                  response: {
                    name: call.name,
                    content: await apiResponse.json(),
                  },
                },
              },
            ],
          }
          addMessage(functionResponseMessage)
          addMessage(newModelMessage)
          /**
           * Send the API response back to the model so it can generate
           * a text response that can be displayed to the user.
           */
          await fetchAnswer({
            messages: messagesRef.current.slice(0, -1),
            model,
            onResponse: (stream) => {
              handleResponse(stream)
            },
            onError: (message, code) => {
              handleError(message, code)
            },
          })
        } catch (err) {
          if (err instanceof Error) {
            handleError(err.message, 500)
          }
        }
      }
    },
    [fetchAnswer, handleResponse, handleError],
  )

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      if (text === '') return Promise.reject(false)
      const { talkMode, model } = useSettingStore.getState()
      const { files, clear: clearAttachment } = useAttachmentStore.getState()
      const { summary, add: addMessage } = useMessageStore.getState()
      const messagePart: Message['parts'] = []
      let talkAudioMode: boolean = false
      if (files.length > 0) {
        for (const file of files) {
          if (isOldVisionModel) {
            if (file.preview) {
              messagePart.push({
                inlineData: {
                  mimeType: file.mimeType,
                  data: file.preview.split(';base64,')[1],
                },
              })
            }
          } else {
            if (file.metadata) {
              messagePart.push({
                fileData: {
                  mimeType: file.metadata.mimeType,
                  fileUri: file.metadata.uri,
                },
              })
            }
          }
        }
      }
      if (text.startsWith('data:audio/webm;base64,') || text.startsWith('data:audio/mp4;base64,')) {
        const audioData = text.substring(5).split(';base64,')
        messagePart.push({
          inlineData: {
            mimeType: audioData[0],
            data: audioData[1],
          },
        })
        talkAudioMode = true
      } else {
        messagePart.push({ text })
      }
      const newUserMessage: Message = {
        id: nanoid(),
        role: 'user',
        parts: messagePart,
      }
      if (files && !isOldVisionModel) {
        newUserMessage.attachments = files
      }
      addMessage(newUserMessage)
      let messages: Message[] = [...messagesRef.current]
      if (talkAudioMode) {
        messages = getTalkAudioPrompt(messages)
      }
      if (talkMode === 'voice') {
        messages = getVoiceModelPrompt(messages)
        setStatus('thinkng')
        setSubtitle('')
      }
      if (summary.content !== '') {
        const newMessages = messages.filter((item) => !summary.ids.includes(item.id))
        messages = [...getSummaryPrompt(summary.content), ...newMessages]
      }
      setContent('')
      clearAttachment()
      setTextareaHeight(TEXTAREA_DEFAULT_HEIGHT)
      await fetchAnswer({
        messages,
        model,
        onResponse: (stream) => {
          handleResponse(stream)
        },
        onFunctionCall: (functionCalls) => {
          handleFunctionCall(functionCalls)
        },
        onError: (message, code) => {
          handleError(message, code)
        },
      })
    },
    [isOldVisionModel, fetchAnswer, handleResponse, handleFunctionCall, handleError],
  )

  const handleResubmit = useCallback(
    async (id: string) => {
      const { model } = useSettingStore.getState()
      const { revoke: rovokeMessage } = useMessageStore.getState()
      if (id !== 'error') {
        const messageIndex = findIndex(messagesRef.current, { id })
        if (messageIndex !== -1) {
          if (messagesRef.current[messageIndex].role === 'model') {
            rovokeMessage(id)
          } else {
            const nextMessage = messagesRef.current[messageIndex + 1]
            if (nextMessage) rovokeMessage(messagesRef.current[messageIndex + 1].id)
          }
        }
      }
      await fetchAnswer({
        messages: [...messagesRef.current],
        model,
        onResponse: (stream) => {
          handleResponse(stream)
        },
        onFunctionCall: (functionCalls) => {
          handleFunctionCall(functionCalls)
        },
        onError: (message, code) => {
          handleError(message, code)
        },
      })
    },
    [fetchAnswer, handleResponse, handleFunctionCall, handleError],
  )

  const handleCleanMessage = useCallback(() => {
    const { clear: clearMessage } = useMessageStore.getState()
    clearMessage()
    setErrorMessage('')
  }, [])

  const updateTalkMode = useCallback((type: 'chat' | 'voice') => {
    const { update } = useSettingStore.getState()
    update({ talkMode: type })
  }, [])

  const checkAccessStatus = useCallback(() => {
    const { isProtected, password, apiKey } = useSettingStore.getState()
    const isProtectedMode = isProtected && password === '' && apiKey === ''
    const isStaticMode = BUILD_MODE === 'export' && apiKey === ''
    if (isProtectedMode || isStaticMode) {
      setSetingOpen(true)
      return false
    } else {
      return true
    }
  }, [])

  const handleRecorder = useCallback(() => {
    if (!checkAccessStatus()) return false
    if (!audioStreamRef.current) {
      audioStreamRef.current = new AudioStream()
    }
    if (!audioRecordRef.current || audioRecordRef.current.autoStop !== autoStopRecord) {
      audioRecordRef.current = new AudioRecorder({
        autoStop: autoStopRecord,
        onStart: () => {
          setIsRecording(true)
        },
        onTimeUpdate: (time) => {
          setRecordTime(time)
        },
        onFinish: async (audioData) => {
          const recordType = getRecordMineType()
          const file = new File([audioData], `${Date.now()}.${recordType.extension}`, { type: recordType.mineType })
          const recordDataURL = await readFileAsDataURL(file)
          handleSubmit(recordDataURL)
          setIsRecording(false)
        },
      })
      audioRecordRef.current.start()
    } else {
      if (audioRecordRef.current.isRecording) {
        audioRecordRef.current.stop()
      } else {
        audioRecordRef.current.start()
      }
    }
  }, [autoStopRecord, checkAccessStatus, handleSubmit])

  const handleStopTalking = useCallback(() => {
    setSpeechSilence(true)
    speechQueue.current?.empty()
    audioStreamRef.current?.stop()
    setStatus('silence')
  }, [])

  const handleKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !isRecording) {
        if (!checkAccessStatus()) return false
        // Prevent the default carriage return and line feed behavior
        ev.preventDefault()
        handleSubmit(content)
      }
    },
    [content, handleSubmit, checkAccessStatus, isRecording],
  )

  const handleFileUpload = useCallback(
    async (files: FileList | null) => {
      if (!supportAttachment) return false
      if (!checkAccessStatus()) return false

      const fileList: File[] = []

      if (files) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          if (mimeType.includes(file.type)) {
            fileList.push(file)
          }
        }

        const { add: addAttachment, update: updateAttachment } = useAttachmentStore.getState()
        if (isOldVisionModel) {
          await imageUpload({ files: fileList, addAttachment, updateAttachment })
        } else {
          const { apiKey, apiProxy, uploadProxy, password } = useSettingStore.getState()
          const options: FileManagerOptions =
            apiKey !== ''
              ? { apiKey, baseUrl: apiProxy, uploadUrl: uploadProxy }
              : { token: encodeToken(password), uploadUrl: uploadProxy }

          await fileUpload({ files: fileList, fileManagerOptions: options, addAttachment, updateAttachment })
        }
      }
    },
    [supportAttachment, isOldVisionModel, checkAccessStatus],
  )

  const handlePaste = useCallback(
    async (ev: React.ClipboardEvent<HTMLDivElement>) => {
      await handleFileUpload(ev.clipboardData?.files)
    },
    [handleFileUpload],
  )

  const handleDrop = useCallback(
    async (ev: React.DragEvent<HTMLDivElement>) => {
      ev.preventDefault()
      await handleFileUpload(ev.dataTransfer?.files)
    },
    [handleFileUpload],
  )

  const initAssistant = useCallback((prompt: string) => {
    const { instruction, clear: clearMessage } = useMessageStore.getState()
    clearMessage()
    instruction(prompt)
  }, [])

  useEffect(() => useMessageStore.subscribe((state) => (messagesRef.current = state.messages)), [])

  useEffect(() => {
    const { ttsLang, ttsVoice, update } = useSettingStore.getState()
    if (ttsLang !== '') {
      const edgeSpeech = new EdgeSpeech({ locale: ttsLang })
      edgeSpeechRef.current = edgeSpeech
      if (ttsVoice === '') {
        const voiceOptions = edgeSpeech.voiceOptions
        update({ ttsVoice: voiceOptions ? (voiceOptions[0].value as string) : 'en-US-EmmaMultilingualNeural' })
      }
    }
  }, [])

  useEffect(() => {
    const { talkMode } = useSettingStore.getState()
    let instance: SiriWave
    if (talkMode === 'chat') {
      instance = new SiriWave({
        container: siriWaveRef.current!,
        style: 'ios9',
        speed: 0.04,
        amplitude: 0.1,
        width: window.innerWidth,
        height: window.innerHeight / 5,
      })
      setSiriWave(instance)
    }

    return () => {
      if (talkMode === 'chat' && instance) {
        instance.dispose()
      }
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-full max-w-screen-md flex-col justify-between pb-20 pt-6 max-sm:pb-16 max-sm:pt-0 landscape:max-md:pt-0">
      <div className="mb-2 mt-6 flex justify-between p-4 pr-2 max-sm:mt-2 max-sm:pr-2 landscape:max-md:mt-0">
        <div className="flex flex-row text-xl leading-8 text-red-400 max-sm:text-base">
          <MessageCircleHeart className="h-10 w-10 max-sm:h-8 max-sm:w-8" />
          <div className="ml-3 font-bold leading-10 max-sm:leading-8">{t('title')}</div>
        </div>
        <div className="flex items-center gap-1">
          <a href="https://github.com/Amery2010/TalkWithGemini" target="_blank">
            <Button className="h-8 w-8" title={t('github')} variant="ghost" size="icon">
              <Github className="h-5 w-5" />
            </Button>
          </a>
          <ThemeToggle />
          <Button
            className="h-8 w-8"
            title={t('setting')}
            variant="ghost"
            size="icon"
            onClick={() => setSetingOpen(true)}
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </div>
      {messages.length === 0 && content === '' && systemInstruction === '' ? (
        <AssistantRecommend initAssistant={initAssistant} />
      ) : (
        <div className="flex min-h-full flex-1 grow flex-col justify-start">
          {systemInstruction !== '' ? (
            <div className="p-4 pt-0">
              <SystemInstruction prompt={systemInstruction} onClear={() => initAssistant('')} />
            </div>
          ) : null}
          {messages.map((msg, idx) => (
            <div
              className={cn(
                'group text-slate-500 transition-colors last:text-slate-800 hover:text-slate-800 dark:last:text-slate-400 dark:hover:text-slate-400 max-sm:hover:bg-transparent',
                msg.role === 'model' && msg.parts && msg.parts[0].functionCall && idx !== messages.length - 1
                  ? 'hidden'
                  : '',
              )}
              key={msg.id}
            >
              <div className="flex gap-3 p-4 hover:bg-gray-50/80 dark:hover:bg-gray-900/80">
                <MessageItem {...msg} onRegenerate={handleResubmit} />
              </div>
            </div>
          ))}
          {message !== '' ? (
            <div className="group text-slate-500 transition-colors last:text-slate-800 hover:text-slate-800 dark:last:text-slate-400 dark:hover:text-slate-400 max-sm:hover:bg-transparent">
              <div className="flex gap-3 p-4 hover:bg-gray-50/80 dark:hover:bg-gray-900/80">
                <MessageItem id="message" role="model" parts={[{ text: message }]} />
              </div>
            </div>
          ) : null}
          {errorMessage !== '' ? (
            <div className="group text-slate-500 transition-colors last:text-slate-800 hover:text-slate-800 dark:last:text-slate-400 dark:hover:text-slate-400 max-sm:hover:bg-transparent">
              <div className="flex gap-3 p-4 hover:bg-gray-50/80 dark:hover:bg-gray-900/80">
                <ErrorMessageItem content={errorMessage} onRegenerate={() => handleResubmit('error')} />
              </div>
            </div>
          ) : null}
          {content !== '' ? (
            <div className="group text-slate-500 transition-colors last:text-slate-800 hover:text-slate-800 dark:last:text-slate-400 dark:hover:text-slate-400 max-sm:hover:bg-transparent">
              <div className="flex gap-3 p-4 hover:bg-gray-50/80 dark:hover:bg-gray-900/80">
                <MessageItem id="preview" role="user" parts={[{ text: content }]} />
              </div>
            </div>
          ) : null}
          {messages.length > 0 ? (
            <div className="my-2 flex h-4 justify-center text-xs text-slate-400 duration-300 dark:text-slate-600">
              {/* <span className="mx-2 cursor-pointer hover:text-slate-500" onClick={() => handleResubmit()}>
                {t('regenerateAnswer')}
              </span>
              <Separator orientation="vertical" /> */}
              <span className="mx-2 cursor-pointer hover:text-slate-500" onClick={() => handleCleanMessage()}>
                {t('clearChatContent')}
              </span>
            </div>
          ) : null}
        </div>
      )}
      <div ref={scrollAreaBottomRef}></div>
      <div className="fixed bottom-0 flex w-full max-w-screen-md items-end gap-2 bg-background p-4 pb-8 max-sm:p-2 max-sm:pb-3 landscape:max-md:pb-4">
        {!isOldVisionModel ? (
          <Button
            className="h-10 w-10 max-sm:h-8 max-sm:w-8"
            title={t('plugin')}
            variant="secondary"
            size="icon"
            onClick={() => setPluginStoreOpen(true)}
          >
            <Blocks className="h-6 w-6 max-sm:h-5 max-sm:w-5" />
          </Button>
        ) : null}
        <div
          className="relative box-border flex w-full flex-1 rounded-md border border-input bg-[hsl(var(--background))] py-1 max-sm:py-0"
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(ev) => ev.preventDefault()}
        >
          <AttachmentArea className="m-2 mt-0 max-h-32 overflow-y-auto border-b border-dashed pb-2" />
          <textarea
            autoFocus
            className={cn(
              'max-h-[120px] w-full resize-none border-none bg-transparent px-2 pt-1 text-sm leading-6 transition-[height] focus-visible:outline-none',
              !supportSpeechRecognition ? 'pr-8' : 'pr-16',
            )}
            style={{ height: `${textareaHeight}px` }}
            value={content}
            placeholder={t('askAQuestion')}
            onChange={(ev) => {
              setContent(ev.target.value)
              setTextareaHeight(ev.target.value === '' ? TEXTAREA_DEFAULT_HEIGHT : ev.target.scrollHeight)
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="absolute bottom-0.5 right-1 flex max-sm:bottom-0">
            {supportAttachment ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="box-border flex h-8 w-8 cursor-pointer items-center justify-center rounded-full p-1.5 text-slate-800 hover:bg-secondary/80 dark:text-slate-600 max-sm:h-7 max-sm:w-7">
                      <FileUploader beforeUpload={() => checkAccessStatus()} />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="mb-1 max-w-36">
                    {isOldVisionModel ? t('imageUploadTooltip') : t('uploadTooltip')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {supportSpeechRecognition ? (
              <TooltipProvider>
                <Tooltip open={isRecording}>
                  <TooltipTrigger asChild>
                    <div
                      className="box-border flex h-8 w-8 cursor-pointer items-center justify-center rounded-full p-1.5 text-slate-800 hover:bg-secondary/80 dark:text-slate-600 max-sm:h-7 max-sm:w-7"
                      onClick={() => handleRecorder()}
                    >
                      <Mic className={isRecording ? 'animate-pulse' : ''} />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    className={cn(
                      'mb-1 px-2 py-1 text-center',
                      isUndefined(audioRecordRef.current?.isRecording) ? '' : 'font-mono text-red-500',
                    )}
                  >
                    {isUndefined(audioRecordRef.current?.isRecording) ? t('startRecording') : formatTime(recordTime)}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </div>
        {content === '' && files.length === 0 && supportSpeechRecognition ? (
          <Button
            className="h-10 w-10 max-sm:h-8 max-sm:w-8"
            title={t('voiceMode')}
            variant="secondary"
            size="icon"
            onClick={() => updateTalkMode('voice')}
          >
            <AudioLines className="h-6 w-6 max-sm:h-5 max-sm:w-5" />
          </Button>
        ) : (
          <Button
            className="h-10 w-10 max-sm:h-8 max-sm:w-8"
            title={t('send')}
            variant="secondary"
            size="icon"
            disabled={isRecording || isUploading}
            onClick={() => handleSubmit(content)}
          >
            <SendHorizontal className="h-6 w-6 max-sm:h-5 max-sm:w-5" />
          </Button>
        )}
      </div>
      <div style={{ display: talkMode === 'voice' ? 'block' : 'none' }}>
        <div className="fixed left-0 right-0 top-0 flex h-full w-screen flex-col items-center justify-center bg-slate-900">
          <div className="h-1/5 w-full" ref={siriWaveRef}></div>
          <div className="absolute bottom-0 flex h-2/5 w-2/3 flex-col justify-between pb-12 text-center">
            <div className="text-sm leading-6">
              <div className="animate-pulse text-lg text-white">{statusText}</div>
              {errorMessage !== '' ? (
                <div className="whitespace-pre-wrap text-center font-semibold text-red-500">{errorMessage}</div>
              ) : status === 'talking' ? (
                <div className="whitespace-pre-wrap text-center text-red-300">{subtitle}</div>
              ) : (
                <div className="whitespace-pre-wrap text-center text-green-300">{content}</div>
              )}
            </div>
            <div className="flex items-center justify-center pt-2">
              <Button
                className="h-10 w-10 rounded-full text-slate-700 dark:text-slate-500"
                title={t('chatMode')}
                variant="secondary"
                size="icon"
                onClick={() => updateTalkMode('chat')}
              >
                <MessageSquareText />
              </Button>
              {status === 'talking' ? (
                <Button
                  className="mx-6 h-14 w-14 rounded-full"
                  title={t('stopTalking')}
                  variant="destructive"
                  size="icon"
                  onClick={() => handleStopTalking()}
                >
                  <Pause />
                </Button>
              ) : (
                <Button
                  className="mx-6 h-14 w-14 rounded-full font-mono"
                  title={t('startRecording')}
                  variant="destructive"
                  size="icon"
                  disabled={status === 'thinkng'}
                  onClick={() => handleRecorder()}
                >
                  {isRecording ? formatTime(recordTime) : <Mic className="h-8 w-8" />}
                </Button>
              )}
              <Button
                className="h-10 w-10 rounded-full text-slate-700 dark:text-slate-500"
                title={t('setting')}
                variant="secondary"
                size="icon"
                onClick={() => setSetingOpen(true)}
              >
                <Settings />
              </Button>
            </div>
          </div>
        </div>
      </div>
      <Setting open={settingOpen} hiddenTalkPanel={!supportSpeechRecognition} onClose={() => setSetingOpen(false)} />
      <PluginStore open={pluginStoreOpen} onClose={() => setPluginStoreOpen(false)} />
    </main>
  )
}
