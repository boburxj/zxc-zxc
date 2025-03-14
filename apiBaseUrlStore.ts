import { ApiBaseUrlChangeStep, ApiBaseUrlConfig } from '@/types/api-base-url'
import { ChromeStorageHelper } from '@/helpers/ChromeStorageHelper'
import { S3_UPDATE_BLOCKER_EXPIRE_MINUTES } from '@/consts/misc'
import { LocalStorageItem } from '@/types/local-storage'
import { ConsoleHelper } from '@/helpers/ConsoleHelper'
import { DateHelper } from '@/helpers/DateHelper'
import { S3Service } from '@/services/S3Service'
import { S3Config } from '@/types/services/s3'
import axios, { AxiosError } from 'axios'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// оставлю типы здесь

export enum ApiBaseUrlChangeStep {
  DEFAULT = 'DEFAULT',
  S3 = 'S3',
  PROXIFIED = 'S3',
}

export type ApiBaseUrlConfig = {
  id: string; // нужен, чтобы как-то определять что флоу подбора уже начат, запихиваю это id в запрос через поле requestId
  activeApiBaseUrl: string;
  previousApiBaseUrl: string;
  apiBaseUrls: string[];
  step: ApiBaseUrlChangeStep;
}

export interface S3Config {
  domains: string[];
  proxies: ProxyConfig[];
  actualBacketUrl?: string;
}

// при этих ошибка, я должен начать перебор
const API_ERROR_CODES_TO_OBSERVE = ['ERR_NETWORK', 'ECONNABORTED', 'ENOTFOUND', 'ECONNREFUSED']

export const useApiBaseUrlStore = defineStore('api-base-url', () => {
  const apiBaseUrls = computed(() => import.meta.env.VITE_BACKEND_BASE_URLS.split(',') as string[])
  const apiBaseUrlConfig = ref<ApiBaseUrlConfig | null>(null) // основной конфиг, чтобы управлять/подбирать следующий base url
  const isThereApiBaseUrls = computed(() => Boolean(apiBaseUrlConfig.value?.apiBaseUrls?.length))
  const apiBaseUrl = computed(() => (apiBaseUrlConfig.value ? apiBaseUrlConfig.value.activeApiBaseUrl : '')) // уйдет во все сервисы, где идут запросы использую axios
  const s3Config = ref<S3Config | null>(null)
  const s3UpdateBlockerExpireAt = ref<Date | null>(null) // expireAt время, так удобнее посчитал

  const isObservableError = (code?: string) => API_ERROR_CODES_TO_OBSERVE.includes(code ?? '')

  const initDefaultConfig = async () => {
    apiBaseUrlConfig.value = await ChromeStorageHelper.get<ApiBaseUrlConfig>(LocalStorageItem.API_BASE_URL_CONFIG)

    if (!apiBaseUrlConfig.value) {
      const [firstApiBaseUrl, ...restApiBaseUrls] = apiBaseUrls.value

      apiBaseUrlConfig.value = {
        id: '',
        activeApiBaseUrl: firstApiBaseUrl,
        previousApiBaseUrl: '',
        apiBaseUrls: restApiBaseUrls,
        step: ApiBaseUrlChangeStep.DEFAULT,
      }
    }

    await ChromeStorageHelper.set(LocalStorageItem.API_BASE_URL_CONFIG, apiBaseUrlConfig.value)
  }

  const initS3Config = async () => {
    if (s3UpdateBlockerExpireAt.value && !DateHelper.isExpired(s3UpdateBlockerExpireAt.value)) {
      return
    }

    try {
      s3Config.value = await S3Service.fetchConfig()

      s3UpdateBlockerExpireAt.value = DateHelper.addMinutes(new Date(), S3_UPDATE_BLOCKER_EXPIRE_MINUTES)
    } catch (error) {
      ConsoleHelper.log(error)
    }
  }

  const resetApiBaseUrlConfigs = () => {

  }
  const updateApiBaseUrlsConfigs = async (url: string, requestId: string) => {
    if (!isThereApiBaseUrls.value) {
      await initS3Config()
    }
  }

  const initInterceptor = () => {
    axios.interceptors.response.use(
      async (response) => {
        const { id } = apiBaseUrlConfig.value || {}

        if (!id) {
          return response
        }

        // когда запрос какой то обработал, то я должен правильно ресетнуть, чтобы при посл разе когда нужно начать подбор домена, сразу брался нужный step
        resetApiBaseUrlConfigs()

        return response
      },
      async (error: AxiosError) => {
        const { code, config } = error

        if (!config?.url || !apiBaseUrlConfig.value) {
          return Promise.reject(error)
        }

        const { url } = config

        if (isObservableError(code)) {
          try {
            const { activeApiBaseUrl, previousApiBaseUrl, id } = apiBaseUrlConfig.value

            // в этой ф должен быть основной флоу, гл задача это обновить apiBaseUrlConfig
            await updateApiBaseUrlsConfigs(url, id)

            if (activeApiBaseUrl && previousApiBaseUrl) {
              const requestConfig = {
                ...config,
                url: url.replace(previousApiBaseUrl, activeApiBaseUrl),
                requestId: id,
              }

              // тут я меняю и повторно вызываю тот же запрос
              return await axios.request(requestConfig)
            }
          } catch {
            return Promise.reject(error)
          }
        }

        return Promise.reject(error)
      },
    )
  }

  const init = async () => {
    initInterceptor()
    await initDefaultConfig()
  }
  const reset = () => {
    ChromeStorageHelper.remove(LocalStorageItem.API_BASE_URL_CONFIG)
    apiBaseUrlConfig.value = null
  }

  return {
    init,
    reset,
    apiBaseUrl,
  }
})
